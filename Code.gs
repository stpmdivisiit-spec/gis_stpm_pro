/**
 * ============================================================================
 * PORTAL GIS TERPADU - GOOGLE APPS SCRIPT BACKEND API (Code.gs)
 * ============================================================================
 * Penyimpanan Utama : Google Spreadsheet (Sheet: "Markers" & "Shapes")
 * Fitur Utama       :
 * - Kompatibilitas penuh dengan struktur kolom lama (Markers & Shapes)
 * - Migrasi kolom otomatis yang aman tanpa menghapus data lama
 * - LockService untuk mencegah race condition / penulisan bersamaan
 * - Operasi batch read/write untuk performa tinggi pada ratusan/ribuan objek
 * - Validasi koordinat (Lat/Lng), GeoJSON, warna HEX, opacity, dan ID unik
 * - Dukungan Insert, Update, Soft Delete (Status = 'Deleted'), dan Bulk Sync
 * - Deteksi konflik berbasis Timestamp / UpdatedAt
 * - Respons JSON terstandarisasi (successResponse & errorResponse)
 * ============================================================================
 */

const SCRIPT_VERSION = '2.1.0';

const SHEET_CONFIG = {
  MARKERS: {
    name: 'Markers',
    // Kolom wajib lama tetap dipertahankan di urutan awal
    legacyHeaders: ['ID', 'Nama', 'Kategori', 'Deskripsi', 'Icon', 'Lat', 'Lng', 'Status', 'Timestamp'],
    // Kolom tambahan untuk fitur profesional (migrasi otomatis)
    extendedHeaders: [
      'Warna',
      'UkuranMarker',
      'CreatedAt',
      'UpdatedAt',
      'CreatedBy',
      'UpdatedBy',
      'Source',
      'AccuracyMeters',
      'ClientId'
    ]
  },
  SHAPES: {
    name: 'Shapes',
    // Kolom wajib lama tetap dipertahankan di urutan awal
    legacyHeaders: ['ID', 'Nama', 'Kategori', 'Deskripsi', 'WarnaArea', 'WarnaGaris', 'Opacity', 'GeoJSON', 'Status', 'Timestamp'],
    // Kolom tambahan untuk fitur profesional (migrasi otomatis)
    extendedHeaders: [
      'KetebalanGaris',
      'LineOpacity',
      'GeometryType',
      'LuasM2',
      'PanjangM',
      'CreatedAt',
      'UpdatedAt',
      'CreatedBy',
      'UpdatedBy',
      'Source',
      'ClientId'
    ]
  }
};

/**
 * Handler HTTP GET
 * Mengambil seluruh data aktif (atau termasuk Deleted jika parameter includeDeleted=true)
 * serta metadata skema dan versi API.
 */
function doGet(e) {
  try {
    const params = (e && e.parameter) ? e.parameter : {};
    const action = params.action || 'get_all';
    const includeDeleted = String(params.includeDeleted || 'false').toLowerCase() === 'true';

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    if (!ss) {
      return errorResponse('Spreadsheet aktif tidak ditemukan. Pastikan script terhubung ke Google Spreadsheet.', 'SPREADSHEET_NOT_FOUND', 500);
    }

    if (action === 'ping' || action === 'health') {
      return successResponse({
        version: SCRIPT_VERSION,
        serverTime: new Date().toISOString(),
        sheets: {
          markers: Boolean(ss.getSheetByName(SHEET_CONFIG.MARKERS.name)),
          shapes: Boolean(ss.getSheetByName(SHEET_CONFIG.SHAPES.name))
        }
      }, 'Layanan API GIS aktif.');
    }

    const markersResult = readSheetRecords_(ss, SHEET_CONFIG.MARKERS, includeDeleted);
    if (!markersResult.ok) {
      return errorResponse(markersResult.error, 'SHEET_READ_ERROR', 500);
    }

    const shapesResult = readSheetRecords_(ss, SHEET_CONFIG.SHAPES, includeDeleted);
    if (!shapesResult.ok) {
      return errorResponse(shapesResult.error, 'SHEET_READ_ERROR', 500);
    }

    return ContentService.createTextOutput(JSON.stringify({
      status: 'success',
      ok: true,
      version: SCRIPT_VERSION,
      serverTime: new Date().toISOString(),
      markers: markersResult.records,
      shapes: shapesResult.records,
      meta: {
        totalMarkers: markersResult.records.length,
        totalShapes: shapesResult.records.length
      }
    })).setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    console.error('[doGet Error]: ' + (err && err.stack ? err.stack : err));
    return errorResponse('Gagal membaca data dari Spreadsheet: ' + (err.message || String(err)), 'INTERNAL_READ_ERROR', 500);
  }
}

/**
 * Handler HTTP POST
 * Menerima operasi penyimpanan tunggal maupun massal (save_bulk, upsert_item, soft_delete, migrate_schema)
 */
function doPost(e) {
  const lock = LockService.getScriptLock();
  let hasLock = false;

  try {
    if (!e || !e.postData || !e.postData.contents) {
      return errorResponse('Body request POST kosong. Kirimkan payload JSON yang valid.', 'EMPTY_POST_BODY', 400);
    }

    let payload;
    try {
      payload = JSON.parse(e.postData.contents);
    } catch (parseErr) {
      return errorResponse('Format JSON pada body POST tidak valid: ' + parseErr.message, 'INVALID_JSON', 400);
    }

    if (!payload || typeof payload !== 'object') {
      return errorResponse('Payload harus berupa objek JSON.', 'INVALID_PAYLOAD', 400);
    }

    const action = String(payload.action || 'save_bulk').trim();

    // Tunggu lock maksimal 20 detik untuk mencegah benturan penulisan bersamaan
    hasLock = lock.tryLock(20000);
    if (!hasLock) {
      return errorResponse('Server sedang memproses penyimpanan lain. Silakan coba beberapa saat lagi.', 'LOCK_TIMEOUT', 429);
    }

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    if (!ss) {
      return errorResponse('Spreadsheet aktif tidak ditemukan.', 'SPREADSHEET_NOT_FOUND', 500);
    }

    if (action === 'save_bulk' || action === 'sync_changes') {
      const data = payload.data || {};
      const markersInput = Array.isArray(data.markers) ? data.markers : [];
      const shapesInput = Array.isArray(data.shapes) ? data.shapes : [];
      const options = {
        actor: sanitizeText_(payload.actor || 'admin', 64),
        clientTimestamp: payload.clientTimestamp || new Date().toISOString(),
        conflictStrategy: payload.conflictStrategy || 'client_wins'
      };

      const markerSaveReport = saveDataToSheet(ss, SHEET_CONFIG.MARKERS, markersInput, 'marker', options);
      if (!markerSaveReport.ok) {
        return errorResponse(markerSaveReport.error, markerSaveReport.code || 'MARKER_SAVE_FAILED', 400, {
          markerReport: markerSaveReport
        });
      }

      const shapeSaveReport = saveDataToSheet(ss, SHEET_CONFIG.SHAPES, shapesInput, 'shape', options);
      if (!shapeSaveReport.ok) {
        return errorResponse(shapeSaveReport.error, shapeSaveReport.code || 'SHAPE_SAVE_FAILED', 400, {
          markerReport: markerSaveReport,
          shapeReport: shapeSaveReport
        });
      }

      SpreadsheetApp.flush();

      const totalFailed = markerSaveReport.failed.length + shapeSaveReport.failed.length;
      const totalProcessed = markerSaveReport.processedCount + shapeSaveReport.processedCount;

      if (totalFailed > 0 && totalProcessed === 0) {
        return errorResponse('Seluruh item gagal divalidasi atau disimpan.', 'ALL_ITEMS_FAILED', 422, {
          markers: markerSaveReport,
          shapes: shapeSaveReport
        });
      }

      return successResponse({
        partialSuccess: totalFailed > 0,
        serverTime: new Date().toISOString(),
        summary: {
          markersInserted: markerSaveReport.inserted.length,
          markersUpdated: markerSaveReport.updated.length,
          markersDeleted: markerSaveReport.deleted.length,
          markersFailed: markerSaveReport.failed.length,
          shapesInserted: shapeSaveReport.inserted.length,
          shapesUpdated: shapeSaveReport.updated.length,
          shapesDeleted: shapeSaveReport.deleted.length,
          shapesFailed: shapeSaveReport.failed.length
        },
        markers: markerSaveReport,
        shapes: shapeSaveReport
      }, totalFailed > 0
        ? 'Sebagian perubahan berhasil disimpan, namun terdapat beberapa item yang gagal divalidasi.'
        : 'Seluruh perubahan berhasil disimpan ke Google Spreadsheet.');
    }

    if (action === 'migrate_schema') {
      const mSheet = ensureSheetAndHeaders_(ss, SHEET_CONFIG.MARKERS, true);
      const sSheet = ensureSheetAndHeaders_(ss, SHEET_CONFIG.SHAPES, true);
      if (!mSheet.ok || !sSheet.ok) {
        return errorResponse((mSheet.error || '') + ' ' + (sSheet.error || ''), 'MIGRATION_ERROR', 500);
      }
      return successResponse({
        markersHeaders: mSheet.headers,
        shapesHeaders: sSheet.headers
      }, 'Migrasi header kolom selesai tanpa mengubah data yang sudah ada.');
    }

    return errorResponse('Action tidak dikenali: ' + action, 'UNKNOWN_ACTION', 400);

  } catch (err) {
    console.error('[doPost Error]: ' + (err && err.stack ? err.stack : err));
    return errorResponse('Kesalahan server saat memproses penyimpanan: ' + (err.message || String(err)), 'INTERNAL_SERVER_ERROR', 500);
  } finally {
    if (hasLock) {
      try {
        lock.releaseLock();
      } catch (releaseErr) {
        console.warn('[Lock Release Warning]: ' + releaseErr);
      }
    }
  }
}

/**
 * Fungsi Utama Penyimpanan Batch ke Sheet (Markers atau Shapes)
 * Tidak pernah mengabaikan sheet yang hilang secara diam-diam.
 */
function saveDataToSheet(ss, sheetSpec, items, itemKind, options) {
  const report = {
    ok: true,
    sheetName: sheetSpec.name,
    processedCount: 0,
    inserted: [],
    updated: [],
    deleted: [],
    conflicts: [],
    failed: []
  };

  if (!Array.isArray(items) || items.length === 0) {
    return report;
  }

  // Pastikan sheet tersedia; jika tidak ditemukan, kembalikan error eksplisit (tidak diabaikan diam-diam)
  const sheetCheck = ensureSheetAndHeaders_(ss, sheetSpec, false);
  if (!sheetCheck.ok) {
    return {
      ok: false,
      code: 'SHEET_NOT_FOUND_OR_INVALID',
      error: sheetCheck.error,
      sheetName: sheetSpec.name,
      processedCount: 0,
      inserted: [],
      updated: [],
      deleted: [],
      conflicts: [],
      failed: []
    };
  }

  const sheet = sheetCheck.sheet;
  const headers = sheetCheck.headers;
  const headerIndexMap = {};
  headers.forEach(function(h, idx) {
    headerIndexMap[h] = idx;
  });

  // Baca seluruh baris yang ada sekali saja (operasi batch)
  const lastRow = sheet.getLastRow();
  const lastCol = headers.length;
  let existingValues = [];
  if (lastRow > 1) {
    existingValues = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
  }

  // Petakan ID -> indeks baris dalam array existingValues (0-based terhadap existingValues)
  const idToRowIndex = {};
  const idColIdx = headerIndexMap['ID'];
  for (let r = 0; r < existingValues.length; r++) {
    const rawId = String(existingValues[r][idColIdx] || '').trim();
    if (rawId) {
      idToRowIndex[rawId] = r;
    }
  }

  const nowIso = new Date().toISOString();
  const seenIdsInBatch = {};
  const newRowsToAppend = [];
  let existingRowsModified = false;

  for (let i = 0; i < items.length; i++) {
    const rawItem = items[i];
    const validation = itemKind === 'marker'
      ? validateMarkerItem_(rawItem, options, nowIso)
      : validateShapeItem_(rawItem, options, nowIso);

    if (!validation.valid) {
      report.failed.push({
        index: i,
        id: rawItem && rawItem.ID ? String(rawItem.ID) : null,
        error: validation.error
      });
      continue;
    }

    const cleanItem = validation.data;
    const itemId = cleanItem.ID;

    // Cegah duplikasi ID dalam batch yang sama (gunakan item terakhir jika ada beberapa update di antrean)
    if (seenIdsInBatch[itemId]) {
      // Tetap lanjutkan untuk memperbarui baris yang sama
    }
    seenIdsInBatch[itemId] = true;

    if (Object.prototype.hasOwnProperty.call(idToRowIndex, itemId)) {
      const rowIdx = idToRowIndex[itemId];
      const currentRow = existingValues[rowIdx];

      // Periksa status dan timestamp yang ada untuk mencegah pengaktifan kembali objek Deleted oleh sinkronisasi usang
      const statusColIdx = headerIndexMap['Status'];
      const tsColIdx = headerIndexMap['Timestamp'];
      const updatedAtColIdx = headerIndexMap['UpdatedAt'];
      const createdAtColIdx = headerIndexMap['CreatedAt'];
      const createdByColIdx = headerIndexMap['CreatedBy'];

      const existingStatus = statusColIdx !== undefined ? String(currentRow[statusColIdx] || '').trim() : 'Active';
      const existingUpdated = (updatedAtColIdx !== undefined && currentRow[updatedAtColIdx])
        ? String(currentRow[updatedAtColIdx])
        : (tsColIdx !== undefined ? String(currentRow[tsColIdx] || '') : '');

      if (existingStatus === 'Deleted' && cleanItem.Status !== 'Deleted' && !rawItem.forceRestore) {
        report.conflicts.push({
          id: itemId,
          reason: 'Objek telah berstatus Deleted di server dan tidak diaktifkan kembali secara otomatis.'
        });
        continue;
      }

      if (options && options.conflictStrategy === 'reject_if_newer' && rawItem.baseTimestamp && existingUpdated) {
        const baseTime = Date.parse(rawItem.baseTimestamp);
        const serverTime = Date.parse(existingUpdated);
        if (!isNaN(baseTime) && !isNaN(serverTime) && serverTime > baseTime) {
          report.conflicts.push({
            id: itemId,
            reason: 'Data di server lebih baru daripada versi lokal.',
            serverTimestamp: existingUpdated
          });
          continue;
        }
      }

      // Pertahankan CreatedAt & CreatedBy asli jika sudah ada di baris lama
      if (createdAtColIdx !== undefined && currentRow[createdAtColIdx]) {
        cleanItem.CreatedAt = currentRow[createdAtColIdx];
      }
      if (createdByColIdx !== undefined && currentRow[createdByColIdx]) {
        cleanItem.CreatedBy = currentRow[createdByColIdx];
      }

      const updatedRow = headers.map(function(colName, colPos) {
        if (Object.prototype.hasOwnProperty.call(cleanItem, colName) && cleanItem[colName] !== undefined) {
          return cleanItem[colName];
        }
        return currentRow[colPos];
      });

      existingValues[rowIdx] = updatedRow;
      existingRowsModified = true;
      report.processedCount++;

      if (cleanItem.Status === 'Deleted') {
        report.deleted.push(itemId);
      } else {
        report.updated.push(itemId);
      }
    } else {
      // Baris baru (Insert)
      const newRow = headers.map(function(colName) {
        return Object.prototype.hasOwnProperty.call(cleanItem, colName) && cleanItem[colName] !== undefined
          ? cleanItem[colName]
          : '';
      });
      newRowsToAppend.push(newRow);
      // Catat di idToRowIndex agar jika ada item dengan ID sama di batch yang sama, ia mengupdate baris tersebut
      existingValues.push(newRow);
      idToRowIndex[itemId] = existingValues.length - 1;
      report.processedCount++;

      if (cleanItem.Status === 'Deleted') {
        report.deleted.push(itemId);
      } else {
        report.inserted.push(itemId);
      }
    }
  }

  // Tulis kembali seluruh data secara batch
  if (existingRowsModified && lastRow > 1) {
    const originalRowCount = lastRow - 1;
    sheet.getRange(2, 1, originalRowCount, lastCol).setValues(existingValues.slice(0, originalRowCount));
  }

  if (newRowsToAppend.length > 0) {
    const startRow = Math.max(sheet.getLastRow() + 1, 2);
    sheet.getRange(startRow, 1, newRowsToAppend.length, lastCol).setValues(newRowsToAppend);
  }

  return report;
}

/**
 * Membaca seluruh baris dari Sheet dan mengubahnya menjadi array objek JSON
 */
function readSheetRecords_(ss, sheetSpec, includeDeleted) {
  const sheetCheck = ensureSheetAndHeaders_(ss, sheetSpec, false);
  if (!sheetCheck.ok) {
    return { ok: false, error: sheetCheck.error, records: [] };
  }

  const sheet = sheetCheck.sheet;
  const headers = sheetCheck.headers;
  const lastRow = sheet.getLastRow();
  if (lastRow <= 1) {
    return { ok: true, records: [] };
  }

  const values = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues();
  const records = [];

  for (let r = 0; r < values.length; r++) {
    const row = values[r];
    const obj = {};
    let hasId = false;

    for (let c = 0; c < headers.length; c++) {
      const key = headers[c];
      let val = row[c];
      if (val instanceof Date) {
        val = val.toISOString();
      }
      obj[key] = val;
      if (key === 'ID' && String(val || '').trim() !== '') {
        hasId = true;
      }
    }

    if (!hasId) continue;

    const status = String(obj.Status || 'Active').trim();
    if (!includeDeleted && status === 'Deleted') {
      continue;
    }

    records.push(obj);
  }

  return { ok: true, records: records };
}

/**
 * Memastikan Sheet ada dan seluruh kolom lama + baru tersedia tanpa menghapus data.
 */
function ensureSheetAndHeaders_(ss, sheetSpec, allowCreateSheet) {
  let sheet = ss.getSheetByName(sheetSpec.name);
  if (!sheet) {
    if (allowCreateSheet) {
      sheet = ss.insertSheet(sheetSpec.name);
    } else {
      return {
        ok: false,
        error: 'Sheet "' + sheetSpec.name + '" tidak ditemukan di Google Spreadsheet. Pastikan nama sheet sesuai.'
      };
    }
  }

  const allRequiredHeaders = sheetSpec.legacyHeaders.concat(sheetSpec.extendedHeaders);
  const lastCol = sheet.getLastColumn();

  if (lastCol === 0 || sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, allRequiredHeaders.length).setValues([allRequiredHeaders]);
    return { ok: true, sheet: sheet, headers: allRequiredHeaders };
  }

  const currentHeaders = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function(h) {
    return String(h || '').trim();
  });

  // Periksa apakah seluruh legacyHeaders ada
  const missingLegacy = sheetSpec.legacyHeaders.filter(function(lh) {
    return currentHeaders.indexOf(lh) === -1;
  });

  if (missingLegacy.length > 0) {
    return {
      ok: false,
      error: 'Header wajib pada sheet "' + sheetSpec.name + '" tidak lengkap. Kolom yang hilang: ' + missingLegacy.join(', ')
    };
  }

  // Tambahkan extendedHeaders di sebelah kanan secara non-destruktif jika belum ada
  const missingExtended = sheetSpec.extendedHeaders.filter(function(eh) {
    return currentHeaders.indexOf(eh) === -1;
  });

  if (missingExtended.length > 0) {
    const startCol = currentHeaders.length + 1;
    sheet.getRange(1, startCol, 1, missingExtended.length).setValues([missingExtended]);
    const mergedHeaders = currentHeaders.concat(missingExtended);
    return { ok: true, sheet: sheet, headers: mergedHeaders };
  }

  return { ok: true, sheet: sheet, headers: currentHeaders };
}

/**
 * Validasi item Marker
 */
function validateMarkerItem_(item, options, nowIso) {
  if (!item || typeof item !== 'object') {
    return { valid: false, error: 'Data marker bukan objek yang valid.' };
  }

  const id = String(item.ID || '').trim();
  if (!id) {
    return { valid: false, error: 'Kolom ID wajib diisi untuk setiap marker.' };
  }

  const status = normalizeStatus_(item.Status);
  const lat = Number(item.Lat);
  const lng = Number(item.Lng);

  if (status !== 'Deleted') {
    if (!isFinite(lat) || lat < -90 || lat > 90) {
      return { valid: false, error: 'Nilai Latitude tidak valid (' + item.Lat + ') untuk ID ' + id };
    }
    if (!isFinite(lng) || lng < -180 || lng > 180) {
      return { valid: false, error: 'Nilai Longitude tidak valid (' + item.Lng + ') untuk ID ' + id };
    }
  }

  const nama = sanitizeText_(item.Nama || 'Tanpa Nama', 200);
  const kategori = sanitizeText_(item.Kategori || 'Lainnya', 150);
  const deskripsi = sanitizeText_(item.Deskripsi || '', 2000);
  const icon = sanitizeText_(item.Icon || 'fa-location-dot', 80);
  const warna = normalizeHexColor_(item.Warna || item.WarnaArea || '#0d6efd', '#0d6efd');
  const ukuranMarker = clampNumber_(item.UkuranMarker, 20, 64, 34);
  const accuracy = (item.AccuracyMeters !== undefined && item.AccuracyMeters !== '' && item.AccuracyMeters !== null && isFinite(Number(item.AccuracyMeters)))
    ? Number(Number(item.AccuracyMeters).toFixed(2))
    : '';
  const actor = (options && options.actor) ? options.actor : 'admin';

  return {
    valid: true,
    data: {
      ID: id,
      Nama: nama,
      Kategori: kategori,
      Deskripsi: deskripsi,
      Icon: icon,
      Lat: isFinite(lat) ? Number(lat.toFixed(7)) : '',
      Lng: isFinite(lng) ? Number(lng.toFixed(7)) : '',
      Status: status,
      Timestamp: nowIso,
      Warna: warna,
      UkuranMarker: ukuranMarker,
      CreatedAt: item.CreatedAt || nowIso,
      UpdatedAt: nowIso,
      CreatedBy: sanitizeText_(item.CreatedBy || actor, 64),
      UpdatedBy: sanitizeText_(item.UpdatedBy || actor, 64),
      Source: sanitizeText_(item.Source || 'WebGIS', 64),
      AccuracyMeters: accuracy,
      ClientId: sanitizeText_(item.ClientId || '', 80)
    }
  };
}

/**
 * Validasi item Shape (Polygon, MultiPolygon, LineString)
 */
function validateShapeItem_(item, options, nowIso) {
  if (!item || typeof item !== 'object') {
    return { valid: false, error: 'Data shape bukan objek yang valid.' };
  }

  const id = String(item.ID || '').trim();
  if (!id) {
    return { valid: false, error: 'Kolom ID wajib diisi untuk setiap shape.' };
  }

  const status = normalizeStatus_(item.Status);
  let geojsonStr = '';
  let geomType = String(item.GeometryType || '').trim();

  if (item.GeoJSON) {
    const parsedCheck = validateGeoJSONGeometry_(item.GeoJSON);
    if (!parsedCheck.valid && status !== 'Deleted') {
      return { valid: false, error: 'GeoJSON tidak valid untuk ID ' + id + ': ' + parsedCheck.error };
    }
    if (parsedCheck.valid) {
      geojsonStr = JSON.stringify(parsedCheck.geometry);
      geomType = parsedCheck.geometry.type;
    } else {
      geojsonStr = typeof item.GeoJSON === 'string' ? item.GeoJSON : JSON.stringify(item.GeoJSON);
    }
  } else if (status !== 'Deleted') {
    return { valid: false, error: 'GeoJSON wajib diisi untuk shape aktif (ID: ' + id + ').' };
  }

  const nama = sanitizeText_(item.Nama || 'Tanpa Nama', 200);
  const kategori = sanitizeText_(item.Kategori || 'Lainnya', 150);
  const deskripsi = sanitizeText_(item.Deskripsi || '', 2000);
  const warnaArea = normalizeHexColor_(item.WarnaArea || '#0d6efd', '#0d6efd');
  const warnaGaris = normalizeHexColor_(item.WarnaGaris || '#6ea8fe', '#6ea8fe');
  const opacity = clampNumber_(item.Opacity, 0, 1, 0.35);
  const lineOpacity = clampNumber_(item.LineOpacity, 0, 1, 0.9);
  const ketebalanGaris = clampNumber_(item.KetebalanGaris, 1, 15, 2.5);
  const luasM2 = (item.LuasM2 !== undefined && item.LuasM2 !== '' && isFinite(Number(item.LuasM2)))
    ? Number(Number(item.LuasM2).toFixed(2))
    : '';
  const panjangM = (item.PanjangM !== undefined && item.PanjangM !== '' && isFinite(Number(item.PanjangM)))
    ? Number(Number(item.PanjangM).toFixed(2))
    : '';
  const actor = (options && options.actor) ? options.actor : 'admin';

  return {
    valid: true,
    data: {
      ID: id,
      Nama: nama,
      Kategori: kategori,
      Deskripsi: deskripsi,
      WarnaArea: warnaArea,
      WarnaGaris: warnaGaris,
      Opacity: opacity,
      GeoJSON: geojsonStr,
      Status: status,
      Timestamp: nowIso,
      KetebalanGaris: ketebalanGaris,
      LineOpacity: lineOpacity,
      GeometryType: geomType || 'Polygon',
      LuasM2: luasM2,
      PanjangM: panjangM,
      CreatedAt: item.CreatedAt || nowIso,
      UpdatedAt: nowIso,
      CreatedBy: sanitizeText_(item.CreatedBy || actor, 64),
      UpdatedBy: sanitizeText_(item.UpdatedBy || actor, 64),
      Source: sanitizeText_(item.Source || 'WebGIS', 64),
      ClientId: sanitizeText_(item.ClientId || '', 80)
    }
  };
}

/**
 * Validasi struktur GeoJSON Geometry (LineString, Polygon, MultiPolygon, Point)
 */
function validateGeoJSONGeometry_(rawGeoJSON) {
  let geom = rawGeoJSON;
  if (typeof rawGeoJSON === 'string') {
    try {
      geom = JSON.parse(rawGeoJSON);
    } catch (e) {
      return { valid: false, error: 'Gagal mengurai string JSON geometri.' };
    }
  }

  if (!geom || typeof geom !== 'object') {
    return { valid: false, error: 'Geometri kosong.' };
  }

  if (geom.type === 'Feature' && geom.geometry) {
    geom = geom.geometry;
  }

  const allowedTypes = ['Polygon', 'MultiPolygon', 'LineString', 'MultiLineString', 'Point'];
  if (allowedTypes.indexOf(geom.type) === -1) {
    return { valid: false, error: 'Tipe geometri tidak didukung: ' + geom.type };
  }

  if (!Array.isArray(geom.coordinates) || geom.coordinates.length === 0) {
    return { valid: false, error: 'Koordinat geometri kosong.' };
  }

  if (geom.type === 'LineString') {
    if (geom.coordinates.length < 2) {
      return { valid: false, error: 'LineString minimal memiliki 2 titik koordinat.' };
    }
    for (let i = 0; i < geom.coordinates.length; i++) {
      if (!isValidCoordPair_(geom.coordinates[i])) {
        return { valid: false, error: 'Koordinat LineString tidak valid pada titik ke-' + (i + 1) };
      }
    }
  } else if (geom.type === 'Polygon') {
    if (!Array.isArray(geom.coordinates[0]) || geom.coordinates[0].length < 4) {
      return { valid: false, error: 'Ring Polygon minimal memiliki 4 koordinat (tertutup).' };
    }
    const ring = geom.coordinates[0];
    for (let i = 0; i < ring.length; i++) {
      if (!isValidCoordPair_(ring[i])) {
        return { valid: false, error: 'Koordinat Polygon tidak valid pada titik ke-' + (i + 1) };
      }
    }
    // Pastikan ring tertutup
    const first = ring[0];
    const last = ring[ring.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) {
      ring.push([first[0], first[1]]);
    }
  }

  return { valid: true, geometry: geom };
}

function isValidCoordPair_(pair) {
  if (!Array.isArray(pair) || pair.length < 2) return false;
  const lng = Number(pair[0]);
  const lat = Number(pair[1]);
  return isFinite(lng) && isFinite(lat) && lng >= -180 && lng <= 180 && lat >= -90 && lat <= 90;
}

function normalizeStatus_(status) {
  const s = String(status || 'Active').trim();
  if (s.toLowerCase() === 'deleted') return 'Deleted';
  if (s.toLowerCase() === 'draft') return 'Draft';
  return 'Active';
}

function normalizeHexColor_(val, fallback) {
  const s = String(val || '').trim();
  if (/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(s)) {
    return s.toLowerCase();
  }
  return fallback;
}

function clampNumber_(val, min, max, fallback) {
  const n = Number(val);
  if (!isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function sanitizeText_(val, maxLen) {
  let str = String(val === undefined || val === null ? '' : val).trim();
  // Cegah formula injection pada Google Spreadsheet
  if (/^[=+\-@]/.test(str)) {
    str = "'" + str;
  }
  if (maxLen && str.length > maxLen) {
    str = str.substring(0, maxLen);
  }
  return str;
}

/**
 * Helper Respons Sukses JSON Konsisten
 */
function successResponse(data, message) {
  const body = {
    status: 'success',
    ok: true,
    code: 200,
    message: message || 'Operasi berhasil.',
    timestamp: new Date().toISOString(),
    data: data || {}
  };
  return ContentService
    .createTextOutput(JSON.stringify(body))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * Helper Respons Error JSON Konsisten
 */
function errorResponse(message, errorCode, httpHint, details) {
  const body = {
    status: 'error',
    ok: false,
    code: httpHint || 400,
    errorCode: errorCode || 'ERROR',
    message: message || 'Terjadi kesalahan pada server.',
    timestamp: new Date().toISOString(),
    details: details || null
  };
  return ContentService
    .createTextOutput(JSON.stringify(body))
    .setMimeType(ContentService.MimeType.JSON);
}
