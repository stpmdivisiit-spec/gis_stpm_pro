// ============================================================================
// PORTAL GIS TERPADU - SISTEM INFORMASI GEOGRAFIS TATA RUANG WILAYAH (script.js)
// Versi Pengembangan Profesional 2.1
// Mempertahankan kompatibilitas penuh dengan struktur Spreadsheet & API asli,
// dilengkapi pengelolaan geometri, styling fleksibel, GPS survei lapangan,
// undo/redo, autosave draft lokal, sinkronisasi terkontrol, & ekspor kartografis.
// ============================================================================

// ==========================================
// 1. KONFIGURASI GLOBAL & STATE APLIKASI
// ==========================================
const API_URL = (window.GIS_CONFIG && window.GIS_CONFIG.API_URL) ||
    'https://script.google.com/macros/s/AKfycbwbEe00oqifJUoDsk7FuidVeOHa513hO2mAIEGCuk5a09RtPersY97LuLO624RPk_g/exec';

const STORAGE_KEYS = {
    THEME: 'gis_stpm_theme_pref',
    DRAFT_QUEUE: 'gis_stpm_draft_queue_v2',
    AUTOSYNC: 'gis_stpm_autosync_enabled',
    CLIENT_ID: 'gis_stpm_client_id'
};

let isAdmin = false;
let drawControl = null;
let fiturSedangDigambar = null;
let draftSession = { markers: [], shapes: [] };
let databaseUtama = { markers: [], shapes: [] };
let isMeasuring = false;
let measureType = 'distance'; // 'distance' | 'area' | 'radius'
let objekSedangDiedit = null;
let objekTerpilihSaatIni = null;
let activeMapMarkers = []; // Menyimpan referensi mapboxgl.Marker agar bebas memory leak
let tempGpsMarker = null;
let tempPreviewMarker = null;
let gadmReferenceData = null;

// State Undo / Redo
const historyStack = {
    undo: [],
    redo: [],
    maxDepth: 30
};

// State Sinkronisasi & Antrean
let autoSyncEnabled = false;
let autoSyncTimer = null;
let isSyncInProgress = false;
let syncRetryCount = 0;
const MAX_SYNC_RETRIES = 3;

// State Geolocation & Survei Lapangan GPS
const gpsState = {
    watchId: null,
    isRecording: false,
    startTime: null,
    timerInterval: null,
    lastPosition: null, // { lat, lng, accuracy, timestamp }
    samples: [] // [{ lat, lng, accuracy, timestamp }]
};

// State Pengaturan Layer & Label Geografis
const layerSettings = {
    showMarkers: true,
    showShapes: true,
    showGadm: false,
    show3dBuildings: true,
    showLabels: true,
    labelFontSize: 12,
    labelMinZoom: 11,
    labelTextColor: '#ffffff',
    labelHaloColor: '#121212',
    labelAllowOverlap: false
};

// Palet Warna Terkurasi (10 Warna Standar GIS)
const CURATED_PALETTE = [
    { name: 'Biru', hex: '#0d6efd', stroke: '#6ea8fe' },
    { name: 'Hijau', hex: '#198754', stroke: '#4dd4ac' },
    { name: 'Merah', hex: '#dc3545', stroke: '#ff6b6b' },
    { name: 'Oranye', hex: '#fd7e14', stroke: '#ffa94d' },
    { name: 'Kuning', hex: '#eab308', stroke: '#fde047' },
    { name: 'Ungu', hex: '#6f42c1', stroke: '#b197fc' },
    { name: 'Toska', hex: '#14b8a6', stroke: '#5eead4' },
    { name: 'Cokelat', hex: '#8b5a2b', stroke: '#c68b59' },
    { name: 'Abu-abu', hex: '#6c757d', stroke: '#adb5bd' },
    { name: 'Magenta', hex: '#d63384', stroke: '#f783ac' }
];

// Pemetaan warna default berdasarkan kata kunci kategori
function getDefaultColorByCategory(kategori) {
    const k = String(kategori || '').toLowerCase();
    if (k.includes('hutan') || k.includes('pertanian') || k.includes('sawah') || k.includes('perkebunan') || k.includes('konservasi')) {
        return { fill: '#198754', stroke: '#4dd4ac' };
    }
    if (k.includes('rawan') || k.includes('bencana') || k.includes('bahaya')) {
        return { fill: '#dc3545', stroke: '#ff6b6b' };
    }
    if (k.includes('pasar') || k.includes('ekonomi') || k.includes('perdagangan') || k.includes('umkm') || k.includes('industri')) {
        return { fill: '#fd7e14', stroke: '#ffa94d' };
    }
    if (k.includes('adat') || k.includes('budaya') || k.includes('sejarah') || k.includes('ibadah')) {
        return { fill: '#6f42c1', stroke: '#b197fc' };
    }
    if (k.includes('air') || k.includes('sungai') || k.includes('irigasi') || k.includes('perikanan') || k.includes('pelabuhan')) {
        return { fill: '#14b8a6', stroke: '#5eead4' };
    }
    if (k.includes('batas')) {
        return { fill: '#eab308', stroke: '#fde047' };
    }
    if (k.includes('permukiman') || k.includes('penduduk')) {
        return { fill: '#8b5a2b', stroke: '#c68b59' };
    }
    return { fill: '#0d6efd', stroke: '#6ea8fe' };
}

// Inisiasi Modal Bootstrap
const modalDataInstance = new bootstrap.Modal(document.getElementById('modalData'));
const modalLogin = new bootstrap.Modal(document.getElementById('modalLogin'));
const modalConfirm = new bootstrap.Modal(document.getElementById('modalConfirm'));
const modalSearch = new bootstrap.Modal(document.getElementById('modalSearch'));
const modalLayerLabel = new bootstrap.Modal(document.getElementById('modalLayerLabel'));
const modalExport = new bootstrap.Modal(document.getElementById('modalExport'));
const modalGeoJSON = new bootstrap.Modal(document.getElementById('modalGeoJSON'));
let confirmCallback = null;

// ==========================================
// 1.1 UTILITAS PENYIMPANAN LOKAL AMAN & TEMA
// ==========================================
function safeStorageGet(key, fallback = null) {
    try {
        const val = window.localStorage.getItem(key);
        return val !== null ? val : fallback;
    } catch (e) {
        return fallback;
    }
}

function safeStorageSet(key, value) {
    try {
        window.localStorage.setItem(key, value);
    } catch (e) {
        // Abaikan jika penyimpanan browser dibatasi (mode privat/iframe)
    }
}

function getClientId() {
    let cid = safeStorageGet(STORAGE_KEYS.CLIENT_ID);
    if (!cid) {
        cid = 'client_' + Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 7);
        safeStorageSet(STORAGE_KEYS.CLIENT_ID, cid);
    }
    return cid;
}

// Sistem Tema: Light Mode, Dark Mode, System Mode
let currentThemePref = 'dark';
let currentBasemapMode = 'street'; // 'street' | 'satellite' | 'outdoors'

function resolveEffectiveTheme(pref) {
    if (pref === 'light' || pref === 'dark') return pref;
    if (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) {
        return 'light';
    }
    return 'dark';
}

function setAppTheme(mode, skipMapStyleUpdate = false) {
    const validModes = ['light', 'dark', 'system'];
    currentThemePref = validModes.includes(mode) ? mode : 'system';
    safeStorageSet(STORAGE_KEYS.THEME, currentThemePref);

    const effective = resolveEffectiveTheme(currentThemePref);
    const rootEl = document.documentElement;
    rootEl.setAttribute('data-theme', currentThemePref);
    rootEl.classList.toggle('resolved-light', effective === 'light');
    rootEl.classList.toggle('resolved-dark', effective === 'dark');

    ['light', 'dark', 'system'].forEach(m => {
        const btn = document.getElementById(`theme-btn-${m}`);
        if (btn) btn.classList.toggle('active', m === currentThemePref);
    });

    // Sesuaikan warna default label geografis agar selalu kontras
    if (effective === 'light' && layerSettings.labelTextColor === '#ffffff' && layerSettings.labelHaloColor === '#121212') {
        layerSettings.labelTextColor = '#0f172a';
        layerSettings.labelHaloColor = '#ffffff';
        const txtIn = document.getElementById('label-text-color');
        const haloIn = document.getElementById('label-halo-color');
        if (txtIn) txtIn.value = '#0f172a';
        if (haloIn) haloIn.value = '#ffffff';
    } else if (effective === 'dark' && layerSettings.labelTextColor === '#0f172a' && layerSettings.labelHaloColor === '#ffffff') {
        layerSettings.labelTextColor = '#ffffff';
        layerSettings.labelHaloColor = '#121212';
        const txtIn = document.getElementById('label-text-color');
        const haloIn = document.getElementById('label-halo-color');
        if (txtIn) txtIn.value = '#ffffff';
        if (haloIn) haloIn.value = '#121212';
    }

    if (!skipMapStyleUpdate && typeof map !== 'undefined' && map && currentBasemapMode === 'street') {
        ubahModePeta('street');
    } else if (typeof map !== 'undefined' && map && map.isStyleLoaded()) {
        applyLayerAndLabelSettings();
    }
}

if (window.matchMedia) {
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    if (mq.addEventListener) {
        mq.addEventListener('change', () => {
            if (currentThemePref === 'system') setAppTheme('system');
        });
    }
}

// ==========================================
// 1.2 FUNGSI LANDING PAGE & SIDEBAR RESPONSIF
// ==========================================
function closeLandingSplash() {
    const splash = document.getElementById('landing-splash');
    if (splash) {
        splash.style.opacity = '0';
        setTimeout(() => splash.remove(), 450);
    }
}

function toggleSidebar(forceOpen) {
    const sidebar = document.getElementById('sidebar-main');
    const floatBtn = document.getElementById('btn-toggle-sidebar-floating');
    if (!sidebar) return;

    const shouldOpen = typeof forceOpen === 'boolean' ? forceOpen : sidebar.classList.contains('collapsed');
    if (shouldOpen) {
        sidebar.classList.remove('collapsed');
        if (floatBtn) floatBtn.classList.add('d-none');
    } else {
        sidebar.classList.add('collapsed');
        if (floatBtn) floatBtn.classList.remove('d-none');
    }
}

function closeDetailBox() {
    const box = document.getElementById('detail-box');
    if (box) box.style.display = 'none';
}

function toggleLegendContent() {
    const body = document.getElementById('dynamic-legend-body');
    const btn = document.getElementById('btn-toggle-legend');
    if (!body || !btn) return;
    const isHidden = body.classList.toggle('d-none');
    btn.innerText = isHidden ? 'Buka' : 'Ringkas';
}

let allCategoriesExpanded = false;
function expandCollapseAllCategories() {
    allCategoriesExpanded = !allCategoriesExpanded;
    document.querySelectorAll('#navigasi-container .submenu-container').forEach(el => {
        el.classList.toggle('aktif', allCategoriesExpanded);
    });
}

// ==========================================
// 1.3 DATA MASTER KATEGORI & IKON
// ==========================================
const defaultCategories = {
    "Administrasi Pemerintahan": ["Kantor Bupati/Wali Kota", "Kantor Camat", "Kantor Kepala Desa", "Balai Desa", "Kantor Dinas/Instansi", "Polsek/Pos Polisi", "Koramil", "Posyandu", "Puskesmas"],
    "Batas Wilayah & Tata Ruang": ["Batas Kabupaten/Kota", "Batas Kecamatan", "Batas Desa/Kelurahan", "Batas Dusun", "Batas Lingkungan/RW", "Batas RT", "Wilayah Adat / Ulayat", "Hutan Lindung", "Hutan Produksi", "Area Konservasi"],
    "Penggunaan Lahan & Ekonomi": ["Lahan Pertanian", "Area Persawahan", "Ladang / Tegalan", "Area Perkebunan", "Area Peternakan", "Area Perikanan / Tambak", "Pasar Tradisional", "Pusat Perdagangan", "Kawasan Industri", "UMKM / Sentra Produksi"],
    "Sosial, Budaya & Kependudukan": ["Permukiman Padat Penduduk", "Permukiman Reguler", "Rumah Adat / Bale", "Tempat Ibadah", "Pemakaman Umum", "Situs Sejarah / Budaya", "Wilayah Komunitas / Suku Tertentu", "Area Rawan Bencana"],
    "Infrastruktur & Fasilitas Umum": ["Jalan Raya / Nasional", "Jalan Desa", "Jembatan", "Pelabuhan / Dermaga", "Terminal / Halte", "Fasilitas Pendidikan (SD/SMP/SMA)", "Fasilitas Kesehatan", "Sumber Air Bersih", "Saluran Irigasi / Sungai", "Menara Telekomunikasi / BTS", "Fasilitas Listrik / Gardu"]
};

const iconList = [
    { class: 'fa-location-dot', name: 'Titik Lokasi (Default)', desc: 'Penanda lokasi standar' },
    { class: 'fa-building-columns', name: 'Kantor Pemerintahan', desc: 'Balai Desa, Kantor Camat, Bupati' },
    { class: 'fa-house-flag', name: 'Rumah Adat / Balai', desc: 'Fasilitas adat, balai pertemuan warga' },
    { class: 'fa-map-location-dot', name: 'Batas Wilayah / Adat', desc: 'Penanda zona, batas desa, ulayat' },
    { class: 'fa-wheat-awn', name: 'Pertanian / Sawah', desc: 'Area persawahan, ladang, panen' },
    { class: 'fa-seedling', name: 'Perkebunan', desc: 'Lahan perkebunan, area hijau, bibit' },
    { class: 'fa-cow', name: 'Peternakan', desc: 'Kawasan kandang, peternakan warga' },
    { class: 'fa-fish-fins', name: 'Perikanan / Tambak', desc: 'Area budidaya ikan, nelayan, pesisir' },
    { class: 'fa-tree', name: 'Hutan / Ruang Terbuka', desc: 'Hutan lindung, area konservasi, taman' },
    { class: 'fa-water', name: 'Sumber Air / Sungai', desc: 'Mata air, irigasi, sungai, danau' },
    { class: 'fa-users', name: 'Demografi / Penduduk', desc: 'Kepadatan penduduk, wilayah komunitas' },
    { class: 'fa-house', name: 'Permukiman Warga', desc: 'Area perumahan, rumah warga' },
    { class: 'fa-shop', name: 'Pasar / Ekonomi', desc: 'Pasar desa, toko, sentra ekonomi UMKM' },
    { class: 'fa-road', name: 'Jalan Raya / Akses', desc: 'Infrastruktur jalan raya, jalan desa' },
    { class: 'fa-bridge-water', name: 'Jembatan', desc: 'Infrastruktur penghubung, jembatan' },
    { class: 'fa-house-medical', name: 'Fasilitas Kesehatan', desc: 'Puskesmas, Posyandu, Klinik desa' },
    { class: 'fa-school', name: 'Fasilitas Pendidikan', desc: 'Sekolah, Pesantren' },
    { class: 'fa-place-of-worship', name: 'Tempat Ibadah', desc: 'Ikon umum tempat ibadah agama' },
    { class: 'fa-monument', name: 'Situs Budaya', desc: 'Monumen, peninggalan sejarah, makam' },
    { class: 'fa-tower-cell', name: 'Menara / BTS', desc: 'Infrastruktur telekomunikasi desa' },
    { class: 'fa-bolt', name: 'Fasilitas Listrik', desc: 'Gardu listrik, penerangan jalan' },
    { class: 'fa-triangle-exclamation', name: 'Rawan Bencana', desc: 'Titik longsor, banjir, zona bahaya' }
];

let kategoriSelect = new TomSelect("#form-kategori", {
    create: true,
    sortField: false,
    placeholder: "Cari atau ketik kategori baru...",
    onChange: function(val) {
        if (val && !objekSedangDiedit) {
            const defColors = getDefaultColorByCategory(val);
            setFormColors(defColors.fill, defColors.stroke);
        }
    }
});

let iconSelect = new TomSelect("#form-icon", {
    valueField: 'class',
    labelField: 'name',
    searchField: ['name', 'class', 'desc'],
    options: iconList,
    create: true,
    onChange: function() {
        updateStylePreview();
    },
    render: {
        option: function(data, escape) {
            return `<div class="d-flex align-items-center p-2 border-bottom border-secondary border-opacity-25">
                        <div class="fs-4 text-primary me-3 text-center" style="width: 36px;"><i class="fa-solid ${escape(data.class)}"></i></div>
                        <div><div class="fw-bold">${escape(data.name)}</div><div class="small text-secondary" style="font-size:0.72rem;">${escape(data.desc || 'Ikon kustom')} | <code>${escape(data.class)}</code></div></div>
                    </div>`;
        },
        item: function(data, escape) {
            return `<div class="d-flex align-items-center fw-bold"><i class="fa-solid ${escape(data.class)} me-2 text-primary fs-6"></i> ${escape(data.name)}</div>`;
        }
    }
});
iconSelect.setValue('fa-location-dot');

// ==========================================
// 1.4 TOAST, CONFIRM & PALET WARNA
// ==========================================
function showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = `custom-toast toast-${type}`;
    const icon = type === 'success' ? 'fa-circle-check text-success'
        : (type === 'warning' ? 'fa-triangle-exclamation text-warning'
        : (type === 'danger' ? 'fa-circle-xmark text-danger' : 'fa-circle-info text-primary'));
    toast.innerHTML = `<i class="fa-solid ${icon} fs-5"></i> <span>${message}</span>`;
    container.appendChild(toast);
    setTimeout(() => {
        toast.classList.add('hide');
        toast.addEventListener('animationend', () => toast.remove());
    }, 3600);
}

function showConfirm(message, callback) {
    document.getElementById('confirm-msg').innerText = message;
    confirmCallback = callback;
    modalConfirm.show();
}

function initColorSwatches() {
    const container = document.getElementById('fill-color-swatches');
    if (!container) return;
    container.innerHTML = '';
    CURATED_PALETTE.forEach(item => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'color-swatch-btn';
        btn.style.backgroundColor = item.hex;
        btn.title = `${item.name} (${item.hex})`;
        btn.onclick = () => {
            setFormColors(item.hex, item.stroke);
            container.querySelectorAll('.color-swatch-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
        };
        container.appendChild(btn);
    });
}

function setFormColors(fillHex, strokeHex) {
    const fillIn = document.getElementById('form-warna-area');
    const fillTxt = document.getElementById('form-warna-area-hex');
    const strokeIn = document.getElementById('form-warna-garis');
    const strokeTxt = document.getElementById('form-warna-garis-hex');
    if (fillIn && fillHex) fillIn.value = fillHex;
    if (fillTxt && fillHex) fillTxt.value = fillHex;
    if (strokeIn && strokeHex) strokeIn.value = strokeHex;
    if (strokeTxt && strokeHex) strokeTxt.value = strokeHex;
    updateStylePreview();
}

function syncHexInput(which) {
    if (which === 'area') {
        const val = document.getElementById('form-warna-area-hex').value.trim();
        if (/^#[0-9a-fA-F]{6}$/.test(val)) {
            document.getElementById('form-warna-area').value = val;
            updateStylePreview();
        }
    } else {
        const val = document.getElementById('form-warna-garis-hex').value.trim();
        if (/^#[0-9a-fA-F]{6}$/.test(val)) {
            document.getElementById('form-warna-garis').value = val;
            updateStylePreview();
        }
    }
}

function hexToRgba(hex, alpha = 1) {
    const clean = String(hex || '#0d6efd').replace('#', '');
    const bigint = parseInt(clean.length === 3 ? clean.split('').map(c => c + c).join('') : clean, 16);
    if (isNaN(bigint)) return `rgba(13, 110, 253, ${alpha})`;
    const r = (bigint >> 16) & 255;
    const g = (bigint >> 8) & 255;
    const b = bigint & 255;
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function updateStylePreview() {
    const fillHex = document.getElementById('form-warna-area')?.value || '#0d6efd';
    const strokeHex = document.getElementById('form-warna-garis')?.value || '#6ea8fe';
    const opacity = parseFloat(document.getElementById('form-opacity')?.value || '0.35');
    const lineWidth = parseFloat(document.getElementById('form-ketebalan-garis')?.value || '2.5');
    const markerSize = parseInt(document.getElementById('form-ukuran-marker')?.value || '34', 10);
    const iconClass = iconSelect ? (iconSelect.getValue() || 'fa-location-dot') : 'fa-location-dot';

    const fillHexTxt = document.getElementById('form-warna-area-hex');
    const strokeHexTxt = document.getElementById('form-warna-garis-hex');
    if (fillHexTxt) fillHexTxt.value = fillHex;
    if (strokeHexTxt) strokeHexTxt.value = strokeHex;

    const lblOp = document.getElementById('label-fill-opacity');
    const lblLw = document.getElementById('label-line-width');
    const lblMs = document.getElementById('label-marker-size');
    if (lblOp) lblOp.innerText = opacity.toFixed(2);
    if (lblLw) lblLw.innerText = `${lineWidth} px`;
    if (lblMs) lblMs.innerText = markerSize;

    const markerSample = document.getElementById('preview-marker-sample');
    if (markerSample) {
        markerSample.style.width = `${markerSize}px`;
        markerSample.style.height = `${markerSize}px`;
        markerSample.style.borderColor = fillHex;
        markerSample.style.color = fillHex;
        markerSample.style.fontSize = `${Math.round(markerSize * 0.44)}px`;
        markerSample.innerHTML = `<i class="fa-solid ${iconClass}"></i>`;
    }

    const polySample = document.getElementById('preview-polygon-sample');
    if (polySample) {
        polySample.style.backgroundColor = hexToRgba(fillHex, opacity);
        polySample.style.borderColor = strokeHex;
        polySample.style.borderWidth = `${Math.min(lineWidth, 6)}px`;
    }
}

// ==========================================
// 2. INISIASI MAPBOX & FALLBACK RESILIENCE
// ==========================================
mapboxgl.accessToken = (window.GIS_CONFIG && window.GIS_CONFIG.MAPBOX_TOKEN) ||
    'pk.eyJ1Ijoib3pub3ZlbCIsImEiOiJjbXVocDg0eTgwYTV6MnhvZHR3eml5MzhxIn0.YRY8_U6ir9nL6BrEi6IbLw';

const STYLE_STREET_DARK = 'mapbox://styles/mapbox/dark-v11';
const STYLE_STREET_LIGHT = 'mapbox://styles/mapbox/light-v11';
const STYLE_SATELLITE = 'mapbox://styles/mapbox/satellite-streets-v12';
const STYLE_OUTDOORS = 'mapbox://styles/mapbox/outdoors-v12';
const INITIAL_VIEW = { center: [121.662, -8.840], zoom: 14, pitch: 55, bearing: -15 };

let map = null;
try {
    map = new mapboxgl.Map({
        container: 'map',
        style: STYLE_STREET_DARK,
        center: INITIAL_VIEW.center,
        zoom: INITIAL_VIEW.zoom,
        pitch: INITIAL_VIEW.pitch,
        bearing: INITIAL_VIEW.bearing,
        preserveDrawingBuffer: true
    });
} catch (mapErr) {
    console.warn('Mapbox GL inisiasi fallback:', mapErr);
}

// ==========================================
// 3. TOOLBAR GIS BERLABEL JELAS & LENGKAP
// ==========================================
class GISExtendedToolbar {
    onAdd(mapInstance) {
        this._map = mapInstance;
        this._container = document.createElement('div');
        // Hindari class 'mapboxgl-ctrl-group' agar CSS bawaan Mapbox (.mapboxgl-ctrl-group button { width: 29px }) tidak memotong teks tombol
        this._container.className = 'mapboxgl-ctrl gis-toolbar-wrapper';

        const toolSections = [
            {
                id: 'group-nav',
                title: 'Navigasi',
                icon: 'fa-compass',
                adminOnly: false,
                tools: [
                    { id: 'tool-zoom-in', icon: 'fa-magnifying-glass-plus', label: 'Perbesar Peta', tooltip: 'Perbesar tampilan peta (Zoom In)', action: () => map && map.zoomIn() },
                    { id: 'tool-zoom-out', icon: 'fa-magnifying-glass-minus', label: 'Perkecil Peta', tooltip: 'Perkecil tampilan peta (Zoom Out)', action: () => map && map.zoomOut() },
                    { id: 'tool-fullext', icon: 'fa-house-chimney', label: 'Tampilan Awal', tooltip: 'Kembali ke tampilan awal wilayah', action: () => resetMapView() },
                    { id: 'tool-gps', icon: 'fa-location-crosshairs', label: 'Lokasi Saya', tooltip: 'Temukan posisi perangkat saat ini', action: () => locateUser(false) },
                    { id: 'tool-search', icon: 'fa-magnifying-glass', label: 'Pencarian Lokasi', tooltip: 'Cari objek, kategori, atau koordinat', action: () => promptSearch() },
                    { id: 'tool-basemap', icon: 'fa-map', label: 'Pilih Basemap', tooltip: 'Ganti basemap Jalan / Satelit / Topografi', action: () => cycleBasemapMode() },
                    { id: 'tool-layers', icon: 'fa-layer-group', label: 'Tampilkan Layer', tooltip: 'Atur visibilitas layer & label geografis', action: () => openLayerLabelModal() },
                    { id: 'tool-coord', icon: 'fa-crosshairs', label: 'Koordinat Kursor', tooltip: 'Tampilkan koordinat kursor di peta', action: () => toggleCoordinatePicker() }
                ]
            },
            {
                id: 'group-draw',
                title: 'Penggambaran',
                icon: 'fa-pen-ruler',
                adminOnly: true,
                tools: [
                    { id: 'tool-identify', icon: 'fa-hand-pointer', label: 'Pilih Objek', tooltip: 'Mode pilih dan identifikasi objek', adminOnly: true, action: () => activateSelectMode() },
                    { id: 'tool-marker', icon: 'fa-map-pin', label: 'Tambah Titik', tooltip: 'Gambar titik lokasi baru di peta', adminOnly: true, action: () => startDrawingTool('point') },
                    { id: 'tool-polyline', icon: 'fa-route', label: 'Gambar Garis', tooltip: 'Gambar garis / jaringan jalan / sungai', adminOnly: true, action: () => startDrawingTool('line') },
                    { id: 'tool-polygon', icon: 'fa-draw-polygon', label: 'Gambar Poligon', tooltip: 'Gambar poligon / batas area wilayah', adminOnly: true, action: () => startDrawingTool('polygon') },
                    { id: 'tool-rect', icon: 'fa-vector-square', label: 'Persegi Panjang', tooltip: 'Buat geometri persegi panjang otomatis', adminOnly: true, action: () => generateShape('rectangle') },
                    { id: 'tool-circle', icon: 'fa-circle-notch', label: 'Gambar Lingkaran', tooltip: 'Buat geometri area lingkaran otomatis', adminOnly: true, action: () => generateShape('circle') },
                    { id: 'tool-edit-geom', icon: 'fa-bezier-curve', label: 'Edit Geometri', tooltip: 'Ubah titik sudut (vertex) objek terpilih', adminOnly: true, action: () => startEditSelectedGeometry() },
                    { id: 'tool-move-obj', icon: 'fa-up-down-left-right', label: 'Pindahkan Objek', tooltip: 'Geser posisi objek terpilih di peta', adminOnly: true, action: () => startMoveSelectedObject() },
                    { id: 'tool-undo', icon: 'fa-rotate-left', label: 'Batalkan (Undo)', tooltip: 'Undo perubahan terakhir pada draft', adminOnly: true, action: () => undoAction() },
                    { id: 'tool-redo', icon: 'fa-rotate-right', label: 'Ulangi (Redo)', tooltip: 'Redo perubahan yang dibatalkan', adminOnly: true, action: () => redoAction() },
                    { id: 'tool-finish-draw', icon: 'fa-check', label: 'Selesaikan Gambar', tooltip: 'Selesaikan penggambaran dan buka formulir', adminOnly: true, variant: 'success', action: () => finishCurrentDrawing() },
                    { id: 'tool-cancel-draw', icon: 'fa-ban', label: 'Batal Menggambar', tooltip: 'Batalkan geometri yang sedang digambar', adminOnly: true, variant: 'danger', action: () => cancelCurrentDrawing() },
                    { id: 'tool-delete', icon: 'fa-trash', label: 'Hapus Geometri', tooltip: 'Hapus geometri yang sedang dipilih', adminOnly: true, variant: 'danger', action: () => deleteSelectedOrActiveObject() }
                ]
            },
            {
                id: 'group-measure',
                title: 'Pengukuran',
                icon: 'fa-ruler-combined',
                adminOnly: false,
                tools: [
                    { id: 'tool-meas-dist', icon: 'fa-ruler', label: 'Ukur Jarak', tooltip: 'Hitung jarak lintasan dalam meter/km', action: () => startMeasurement('distance') },
                    { id: 'tool-meas-area', icon: 'fa-ruler-combined', label: 'Ukur Luas', tooltip: 'Hitung luas poligon dalam m² dan hektar', action: () => startMeasurement('area') },
                    { id: 'tool-meas-radius', icon: 'fa-compass-drafting', label: 'Ukur Radius', tooltip: 'Ukur radius jangkauan dari titik pusat', action: () => startMeasurement('radius') },
                    { id: 'tool-meas-clear', icon: 'fa-broom', label: 'Hapus Pengukuran', tooltip: 'Bersihkan hasil pengukuran dari peta', variant: 'danger', action: () => stopMeasurement() }
                ]
            },
            {
                id: 'group-gps-survey',
                title: 'Survei Lapangan',
                icon: 'fa-satellite-dish',
                adminOnly: false,
                tools: [
                    { id: 'tool-gps-panel', icon: 'fa-satellite', label: 'Panel GPS Survei', tooltip: 'Buka panel survei lapangan & status akurasi GPS', action: () => openGpsSurveyPanel() },
                    { id: 'tool-gps-add-pt', icon: 'fa-location-pin-lock', label: 'Tambah Titik GPS', tooltip: 'Ambil titik objek dari posisi GPS saya', adminOnly: true, action: () => addPointFromMyLocation() },
                    { id: 'tool-gps-rec-start', icon: 'fa-play', label: 'Mulai Rekam GPS', tooltip: 'Mulai merekam jejak koordinat batas wilayah', adminOnly: true, variant: 'success', action: () => { openGpsSurveyPanel(); startGpsTrackRecording(); } },
                    { id: 'tool-gps-rec-stop', icon: 'fa-stop', label: 'Hentikan Rekaman', tooltip: 'Hentikan perekaman jejak GPS', adminOnly: true, variant: 'danger', action: () => stopGpsTrackRecording() },
                    { id: 'tool-gps-save', icon: 'fa-floppy-disk', label: 'Simpan Survei', tooltip: 'Validasi dan simpan hasil rekaman survei GPS', adminOnly: true, variant: 'success', action: () => finishAndSaveGpsSurvey() }
                ]
            },
            {
                id: 'group-data-export',
                title: 'Data & Laporan',
                icon: 'fa-database',
                adminOnly: false,
                tools: [
                    { id: 'tool-save-changes', icon: 'fa-cloud-arrow-up', label: 'Simpan Perubahan', tooltip: 'Simpan antrean draft ke Google Spreadsheet', adminOnly: true, variant: 'success', action: () => kirimDraftKeServer() },
                    { id: 'tool-sync-data', icon: 'fa-arrows-rotate', label: 'Sinkronkan Data', tooltip: 'Muat ulang & sinkronkan data dari Spreadsheet', action: () => ambilDataDariServer(true) },
                    { id: 'tool-import-geojson', icon: 'fa-file-import', label: 'Impor GeoJSON', tooltip: 'Impor file atau teks GeoJSON ke peta', adminOnly: true, action: () => openGeoJSONModal('import') },
                    { id: 'tool-export-geojson', icon: 'fa-file-code', label: 'Ekspor GeoJSON', tooltip: 'Unduh seluruh data aktif dalam format GeoJSON', action: () => exportAllDataAsGeoJSON() },
                    { id: 'tool-export-jpg', icon: 'fa-image', label: 'Ekspor Gambar JPG', tooltip: 'Ekspor peta kartografis ke gambar JPG/PNG', action: () => openExportModal('jpg') },
                    { id: 'tool-export-pdf', icon: 'fa-file-pdf', label: 'Ekspor Laporan PDF', tooltip: 'Ekspor laporan peta & tabel objek ke PDF', action: () => openExportModal('pdf') }
                ]
            }
        ];

        toolSections.forEach((section, secIdx) => {
            const groupDiv = document.createElement('div');
            groupDiv.className = 'tool-group';
            groupDiv.id = section.id;
            // Buka grup Navigasi secara default, ringkas grup lainnya (Accordion) agar rapi dan proporsional
            if (secIdx > 0) groupDiv.classList.add('group-collapsed');
            if (section.adminOnly) groupDiv.classList.add('admin-only-group', 'd-none');

            const header = document.createElement('button');
            header.type = 'button';
            header.className = 'tool-group-header';
            header.setAttribute('aria-expanded', secIdx === 0 ? 'true' : 'false');
            header.innerHTML = `
                <span class="tool-group-title-wrap">
                    <span class="tool-group-badge-icon"><i class="fa-solid ${section.icon}"></i></span>
                    <span class="text-truncate">${section.title}</span>
                </span>
                <i class="fa-solid fa-chevron-down tool-group-chevron"></i>`;

            header.onclick = (e) => {
                e.preventDefault();
                const isCurrentlyCollapsed = groupDiv.classList.contains('group-collapsed');
                // Perilaku Accordion: tutup grup lain saat membuka grup baru agar panel kanan tetap ringkas
                this._container.querySelectorAll('.tool-group').forEach(otherGroup => {
                    if (otherGroup !== groupDiv) {
                        otherGroup.classList.add('group-collapsed');
                        const h = otherGroup.querySelector('.tool-group-header');
                        if (h) h.setAttribute('aria-expanded', 'false');
                    }
                });
                groupDiv.classList.toggle('group-collapsed', !isCurrentlyCollapsed);
                header.setAttribute('aria-expanded', isCurrentlyCollapsed ? 'true' : 'false');
            };
            groupDiv.appendChild(header);

            const bodyDiv = document.createElement('div');
            bodyDiv.className = 'tool-group-body';

            section.tools.forEach(t => {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.id = t.id;
                btn.className = 'gis-toolbar-btn' + (t.variant ? ` tool-variant-${t.variant}` : '');
                btn.title = t.tooltip || t.label;
                btn.setAttribute('data-tooltip', t.tooltip || t.label);
                btn.innerHTML = `<span class="tool-icon-box"><i class="fa-solid ${t.icon}"></i></span><span class="tool-label">${t.label}</span>`;

                if (t.adminOnly) {
                    btn.classList.add('admin-only-tool', 'd-none');
                }

                btn.onclick = (e) => {
                    e.preventDefault();
                    document.querySelectorAll('.gis-toolbar-btn').forEach(b => b.classList.remove('active-tool'));
                    btn.classList.add('active-tool');
                    t.action();
                };
                bodyDiv.appendChild(btn);
            });

            groupDiv.appendChild(bodyDiv);
            this._container.appendChild(groupDiv);
        });

        return this._container;
    }

    onRemove() {
        if (this._container && this._container.parentNode) {
            this._container.parentNode.removeChild(this._container);
        }
        this._map = undefined;
    }
}

// ==========================================
// 4. INISIASI EVENT DOM, RESIZER & MAP LOAD
// ==========================================
document.addEventListener('DOMContentLoaded', () => {
    initColorSwatches();
    updateStylePreview();

    // Muat preferensi tema yang tersimpan
    const savedTheme = safeStorageGet(STORAGE_KEYS.THEME, 'dark');
    setAppTheme(savedTheme, true);

    // Muat preferensi Auto-Sync
    autoSyncEnabled = safeStorageGet(STORAGE_KEYS.AUTOSYNC, 'false') === 'true';
    const autoSyncToggle = document.getElementById('toggle-autosync');
    if (autoSyncToggle) autoSyncToggle.checked = autoSyncEnabled;

    // Pulihkan draft lokal yang belum tersinkronisasi jika ada
    restoreLocalDraftQueue();

    // Konfirmasi modal listener
    const btnConfirm = document.getElementById('btn-confirm-yes');
    if (btnConfirm) {
        btnConfirm.addEventListener('click', () => {
            modalConfirm.hide();
            if (confirmCallback) confirmCallback();
        });
    }

    // Filter cakupan ekspor
    const expScope = document.getElementById('export-filter-scope');
    if (expScope) {
        expScope.addEventListener('change', () => {
            const wrap = document.getElementById('export-category-filter-wrap');
            if (wrap) wrap.classList.toggle('d-none', expScope.value !== 'category');
        });
    }

    // Sidebar Resizer untuk Desktop
    initSidebarResizer();

    // Peringatan sebelum meninggalkan halaman jika ada draft atau rekaman GPS aktif
    window.addEventListener('beforeunload', (e) => {
        const hasDrafts = (draftSession.markers.length + draftSession.shapes.length) > 0;
        if (hasDrafts || gpsState.isRecording) {
            e.preventDefault();
            e.returnValue = 'Masih ada perubahan draft atau rekaman survei GPS yang belum disimpan.';
        }
    });
});

function initSidebarResizer() {
    const resizer = document.getElementById('sidebar-resizer');
    const sidebar = document.getElementById('sidebar-main');
    if (!resizer || !sidebar) return;

    let isResizing = false;
    resizer.addEventListener('mousedown', (e) => {
        if (window.innerWidth <= 768) return;
        isResizing = true;
        document.body.style.cursor = 'ew-resize';
        e.preventDefault();
    });

    window.addEventListener('mousemove', (e) => {
        if (!isResizing) return;
        const newWidth = Math.min(520, Math.max(290, e.clientX - 16));
        document.documentElement.style.setProperty('--sidebar-width', `${newWidth}px`);
    });

    window.addEventListener('mouseup', () => {
        if (isResizing) {
            isResizing = false;
            document.body.style.cursor = '';
            if (map) map.resize();
        }
    });
}

if (map) {
    map.addControl(new GISExtendedToolbar(), 'top-right');

    map.on('load', async () => {
        drawControl = new MapboxDraw({
            displayControlsDefault: false,
            controls: {},
            defaultMode: 'simple_select'
        });
        map.addControl(drawControl, 'bottom-right');

        map.on('draw.create', handleDrawCreate);
        map.on('draw.update', handleDrawUpdate);
        map.on('draw.selectionchange', handleDrawSelectionChange);

        renderGedung3DBawaan();
        await loadGadmReferenceGeoJSON();
        await ambilDataDariServer();
    });
} else {
    // Jika WebGL tidak tersedia di lingkungan terbatas, tetap jalankan pemuatan data
    setTimeout(() => {
        loadGadmReferenceGeoJSON();
        ambilDataDariServer();
    }, 100);
}

// ==========================================
// 5. DRAW EVENTS, PENGEDITAN GEOMETRI & PEMINDAHAN
// ==========================================
let isEditingExistingGeometry = false;
let isMovingExistingObject = false;
let movingMarkerInstance = null;

function activateSelectMode() {
    if (map) map.getCanvas().style.cursor = 'default';
    if (drawControl) drawControl.changeMode('simple_select');
    hideDrawingBanner();
}

function startDrawingTool(toolType) {
    if (!isAdmin) {
        showToast('Silakan Login Admin terlebih dahulu untuk menggambar objek.', 'warning');
        modalLogin.show();
        return;
    }
    if (!drawControl) return showToast('Kontrol penggambaran belum siap.', 'danger');

    isMeasuring = false;
    isEditingExistingGeometry = false;
    objekSedangDiedit = null;
    drawControl.deleteAll();

    if (toolType === 'point') {
        drawControl.changeMode('draw_point');
        showDrawingBanner('Klik pada peta untuk menempatkan titik lokasi baru.');
    } else if (toolType === 'line') {
        drawControl.changeMode('draw_line_string');
        showDrawingBanner('Klik titik-titik jalur pada peta, lalu klik Selesaikan Gambar.');
    } else if (toolType === 'polygon') {
        drawControl.changeMode('draw_polygon');
        showDrawingBanner('Klik titik-titik batas area pada peta, lalu klik Selesaikan Gambar.');
    }
}

function showDrawingBanner(text) {
    const banner = document.getElementById('drawing-helper-banner');
    const txt = document.getElementById('drawing-helper-text');
    if (txt) txt.innerText = text;
    if (banner) banner.classList.remove('d-none');
}

function hideDrawingBanner() {
    const banner = document.getElementById('drawing-helper-banner');
    if (banner) banner.classList.add('d-none');
}

function handleDrawCreate(e) {
    if (isMeasuring) {
        calculateMeasurement(e);
        return;
    }
    if (!isAdmin) {
        if (drawControl) drawControl.deleteAll();
        return;
    }
    fiturSedangDigambar = e.features[0];
    hideDrawingBanner();
    openFormForNewFeature(fiturSedangDigambar);
}

function handleDrawUpdate(e) {
    if (isMeasuring) {
        calculateMeasurement(e);
        return;
    }
    if (isEditingExistingGeometry && e.features && e.features.length > 0) {
        fiturSedangDigambar = e.features[0];
    }
}

function handleDrawSelectionChange(e) {
    if (isEditingExistingGeometry && e.features && e.features.length > 0) {
        fiturSedangDigambar = e.features[0];
    }
}

function finishCurrentDrawing() {
    if (isMeasuring) {
        calculateMeasurement();
        return;
    }
    if (isMovingExistingObject && objekSedangDiedit) {
        if (movingMarkerInstance) {
            const lngLat = movingMarkerInstance.getLngLat();
            pushUndoSnapshot();
            objekSedangDiedit.Lat = Number(lngLat.lat.toFixed(6));
            objekSedangDiedit.Lng = Number(lngLat.lng.toFixed(6));
            upsertItemIntoDraft(objekSedangDiedit, true);
            movingMarkerInstance.remove();
            movingMarkerInstance = null;
            isMovingExistingObject = false;
            objekSedangDiedit = null;
            hideDrawingBanner();
            renderMenuKategori();
            renderObjekKePeta();
            showToast('Posisi titik berhasil dipindahkan dan disimpan ke Draft.', 'success');
            return;
        }
    }

    if (isEditingExistingGeometry && objekSedangDiedit && drawControl) {
        const all = drawControl.getAll();
        if (all.features.length > 0) {
            const editedFeat = all.features[0];
            pushUndoSnapshot();
            if (editedFeat.geometry.type === 'Point') {
                objekSedangDiedit.Lat = Number(editedFeat.geometry.coordinates[1].toFixed(6));
                objekSedangDiedit.Lng = Number(editedFeat.geometry.coordinates[0].toFixed(6));
                upsertItemIntoDraft(objekSedangDiedit, true);
            } else {
                const metrics = computeGeometryMetrics(editedFeat.geometry);
                objekSedangDiedit.GeoJSON = JSON.stringify(editedFeat.geometry);
                objekSedangDiedit.GeometryType = editedFeat.geometry.type;
                objekSedangDiedit.LuasM2 = metrics.areaM2;
                objekSedangDiedit.PanjangM = metrics.lengthM;
                upsertItemIntoDraft(objekSedangDiedit, false);
            }
            drawControl.deleteAll();
            isEditingExistingGeometry = false;
            objekSedangDiedit = null;
            hideDrawingBanner();
            renderMenuKategori();
            renderObjekKePeta();
            showToast('Perubahan bentuk geometri berhasil disimpan ke Draft.', 'success');
            return;
        }
    }

    if (drawControl) {
        const all = drawControl.getAll();
        if (all.features.length > 0) {
            fiturSedangDigambar = all.features[all.features.length - 1];
            drawControl.changeMode('simple_select');
            hideDrawingBanner();
            openFormForNewFeature(fiturSedangDigambar);
        } else {
            showToast('Belum ada titik/geometri yang digambar di peta.', 'warning');
        }
    }
}

function cancelCurrentDrawing() {
    if (drawControl) drawControl.deleteAll();
    if (movingMarkerInstance) {
        movingMarkerInstance.remove();
        movingMarkerInstance = null;
    }
    fiturSedangDigambar = null;
    isEditingExistingGeometry = false;
    isMovingExistingObject = false;
    hideDrawingBanner();
    showToast('Penggambaran geometri dibatalkan.', 'info');
}

function openFormForNewFeature(feature, sourceLabel = 'WebGIS', accuracyMeters = null) {
    fiturSedangDigambar = feature;
    objekSedangDiedit = null;

    const alertEl = document.getElementById('form-validation-alert');
    if (alertEl) alertEl.classList.add('d-none');

    document.getElementById('modal-data-title').innerHTML = `<i class="fa-solid fa-map-location-dot text-primary me-2"></i>Tambah Objek Geografis Baru`;
    document.getElementById('form-nama').value = '';
    document.getElementById('form-deskripsi').value = '';
    kategoriSelect.clear();

    const isPoint = feature && feature.geometry && feature.geometry.type === 'Point';
    document.getElementById('group-marker-options').style.display = isPoint ? 'block' : 'none';
    document.getElementById('group-shape-sliders').style.display = isPoint ? 'none' : 'flex';
    document.getElementById('group-warna-garis').style.display = isPoint ? 'none' : 'block';
    document.getElementById('manual-latlng-row').style.display = isPoint ? 'flex' : 'none';

    const accInfo = document.getElementById('form-gps-accuracy-info');
    if (accInfo) {
        if (accuracyMeters !== null && isFinite(accuracyMeters)) {
            accInfo.classList.remove('d-none');
            accInfo.innerHTML = `<i class="fa-solid fa-satellite-dish me-1"></i>Sumber: <b>${sourceLabel}</b> | Estimasi Akurasi Browser: <b>&plusmn;${Number(accuracyMeters).toFixed(1)} meter</b> (bukan jaminan presisi mutlak).`;
            fiturSedangDigambar.properties = { ...(fiturSedangDigambar.properties || {}), Source: sourceLabel, AccuracyMeters: accuracyMeters };
        } else {
            accInfo.classList.add('d-none');
        }
    }

    tarikKoordinatPeta();
    updateStylePreview();
    modalDataInstance.show();
}

function startEditSelectedGeometry() {
    if (!isAdmin) return showToast('Fitur Edit Geometri hanya untuk Admin.', 'warning');
    if (!objekTerpilihSaatIni) return showToast('Pilih salah satu objek pada peta atau daftar terlebih dahulu.', 'warning');

    closeDetailBox();
    objekSedangDiedit = { ...objekTerpilihSaatIni };
    isEditingExistingGeometry = true;

    if (drawControl) {
        drawControl.deleteAll();
        let feat;
        if (objekSedangDiedit.Lat !== undefined && objekSedangDiedit.Lat !== '') {
            feat = {
                id: String(objekSedangDiedit.ID),
                type: 'Feature',
                properties: {},
                geometry: {
                    type: 'Point',
                    coordinates: [parseFloat(objekSedangDiedit.Lng), parseFloat(objekSedangDiedit.Lat)]
                }
            };
        } else if (objekSedangDiedit.GeoJSON) {
            feat = {
                id: String(objekSedangDiedit.ID),
                type: 'Feature',
                properties: {},
                geometry: JSON.parse(objekSedangDiedit.GeoJSON)
            };
        }
        if (feat) {
            const ids = drawControl.add(feat);
            drawControl.changeMode('direct_select', { featureId: ids[0] });
            showDrawingBanner(`Geser titik sudut "${objekSedangDiedit.Nama}", lalu klik Selesaikan Gambar.`);
        }
    }
}

function startMoveSelectedObject() {
    if (!isAdmin) return showToast('Fitur Pindahkan Objek hanya untuk Admin.', 'warning');
    if (!objekTerpilihSaatIni) return showToast('Pilih objek yang ingin dipindahkan terlebih dahulu.', 'warning');

    closeDetailBox();
    objekSedangDiedit = { ...objekTerpilihSaatIni };

    if (objekSedangDiedit.Lat !== undefined && objekSedangDiedit.Lat !== '' && map) {
        isMovingExistingObject = true;
        if (movingMarkerInstance) movingMarkerInstance.remove();
        movingMarkerInstance = new mapboxgl.Marker({ draggable: true, color: '#ffc107' })
            .setLngLat([parseFloat(objekSedangDiedit.Lng), parseFloat(objekSedangDiedit.Lat)])
            .addTo(map);
        showDrawingBanner(`Tarik penanda kuning untuk memindahkan "${objekSedangDiedit.Nama}", lalu klik Selesaikan Gambar.`);
    } else {
        startEditSelectedGeometry();
    }
}

function deleteSelectedOrActiveObject() {
    if (!isAdmin) return showToast('Hanya Admin yang dapat menghapus objek.', 'warning');
    if (objekTerpilihSaatIni) {
        prosesHapusObjek(objekTerpilihSaatIni);
        return;
    }
    if (drawControl) {
        const selected = drawControl.getSelected();
        if (selected && selected.features.length > 0) {
            drawControl.trash();
            showToast('Geometri yang sedang digambar dihapus.', 'info');
            return;
        }
    }
    showToast('Pilih objek terlebih dahulu untuk dihapus.', 'warning');
}

// ==========================================
// 5.1 UNDO / REDO MANAJEMEN PERUBAHAN DRAFT
// ==========================================
function pushUndoSnapshot() {
    const snapshot = JSON.stringify(draftSession);
    historyStack.undo.push(snapshot);
    if (historyStack.undo.length > historyStack.maxDepth) {
        historyStack.undo.shift();
    }
    historyStack.redo = [];
}

function undoAction() {
    if (historyStack.undo.length === 0) {
        return showToast('Tidak ada tindakan sebelumnya untuk dibatalkan (Undo).', 'info');
    }
    historyStack.redo.push(JSON.stringify(draftSession));
    const prev = JSON.parse(historyStack.undo.pop());
    draftSession = prev;
    persistLocalDraftQueue();
    updateDraftCounterUI();
    renderMenuKategori();
    renderObjekKePeta();
    showToast('Tindakan terakhir dibatalkan (Undo).', 'info');
}

function redoAction() {
    if (historyStack.redo.length === 0) {
        return showToast('Tidak ada tindakan untuk diulangi (Redo).', 'info');
    }
    historyStack.undo.push(JSON.stringify(draftSession));
    const next = JSON.parse(historyStack.redo.pop());
    draftSession = next;
    persistLocalDraftQueue();
    updateDraftCounterUI();
    renderMenuKategori();
    renderObjekKePeta();
    showToast('Tindakan berhasil diulangi (Redo).', 'info');
}

// ==========================================
// 5.2 BASEMAP, LAYER & LABEL GEOGRAFIS
// ==========================================
function ubahModePeta(mode) {
    currentBasemapMode = mode;
    ['street', 'satellite', 'outdoors'].forEach(m => {
        const btn = document.getElementById('btn-mode-' + m);
        if (btn) btn.classList.toggle('active', m === mode);
    });

    if (!map) return;

    const effectiveTheme = resolveEffectiveTheme(currentThemePref);
    let targetStyle = STYLE_STREET_DARK;
    if (mode === 'satellite') targetStyle = STYLE_SATELLITE;
    else if (mode === 'outdoors') targetStyle = STYLE_OUTDOORS;
    else targetStyle = effectiveTheme === 'light' ? STYLE_STREET_LIGHT : STYLE_STREET_DARK;

    map.setStyle(targetStyle);
    map.once('style.load', () => {
        if (mode === 'street' && layerSettings.show3dBuildings) renderGedung3DBawaan();
        renderGadmLayerToMap();
        renderObjekKePeta();
        renderGpsTrackOnMap();
    });
}

function cycleBasemapMode() {
    const order = ['street', 'satellite', 'outdoors'];
    const nextIdx = (order.indexOf(currentBasemapMode) + 1) % order.length;
    ubahModePeta(order[nextIdx]);
}

function resetMapView() {
    if (!map) return;
    map.flyTo({
        center: INITIAL_VIEW.center,
        zoom: INITIAL_VIEW.zoom,
        pitch: INITIAL_VIEW.pitch,
        bearing: INITIAL_VIEW.bearing,
        duration: 1600
    });
}

function renderGedung3DBawaan() {
    if (!map || !map.getStyle()) return;
    if (!layerSettings.show3dBuildings) {
        if (map.getLayer('add-3d-buildings')) map.removeLayer('add-3d-buildings');
        return;
    }
    if (!map.getLayer('add-3d-buildings')) {
        const layers = map.getStyle().layers || [];
        const labelLayerId = layers.find((l) => l.type === 'symbol' && l.layout && l.layout['text-field'])?.id;
        const effectiveTheme = resolveEffectiveTheme(currentThemePref);
        try {
            map.addLayer({
                'id': 'add-3d-buildings',
                'source': 'composite',
                'source-layer': 'building',
                'filter': ['==', 'extrude', 'true'],
                'type': 'fill-extrusion',
                'minzoom': 14,
                'paint': {
                    'fill-extrusion-color': effectiveTheme === 'light' ? '#cbd5e1' : '#343a40',
                    'fill-extrusion-height': ['get', 'height'],
                    'fill-extrusion-base': ['get', 'min_height'],
                    'fill-extrusion-opacity': 0.75
                }
            }, labelLayerId);
        } catch (e) {
            // Abaikan jika style basemap tidak memiliki source composite building
        }
    }
}

async function loadGadmReferenceGeoJSON() {
    if (window.INLINE_GADM_ENDE) {
        gadmReferenceData = window.INLINE_GADM_ENDE;
        renderGadmLayerToMap();
        return;
    }
    try {
        const gadmFile = 'gadm41_ende.json'; const res = await fetch(gadmFile);
        if (res.ok) {
            gadmReferenceData = await res.json();
            renderGadmLayerToMap();
        }
    } catch (e) {
        // File referensi opsional
    }
}

function renderGadmLayerToMap() {
    if (!map || !map.isStyleLoaded() || !gadmReferenceData) return;

    ['gadm-ende-label', 'gadm-ende-line', 'gadm-ende-fill'].forEach(lid => {
        if (map.getLayer(lid)) map.removeLayer(lid);
    });
    if (map.getSource('gadm-ende-source')) map.removeSource('gadm-ende-source');

    if (!layerSettings.showGadm) return;

    map.addSource('gadm-ende-source', {
        type: 'geojson',
        data: gadmReferenceData
    });

    map.addLayer({
        id: 'gadm-ende-fill',
        type: 'fill',
        source: 'gadm-ende-source',
        paint: {
            'fill-color': '#eab308',
            'fill-opacity': 0.08
        }
    });

    map.addLayer({
        id: 'gadm-ende-line',
        type: 'line',
        source: 'gadm-ende-source',
        paint: {
            'line-color': '#f59e0b',
            'line-width': 1.5,
            'line-dasharray': [3, 2]
        }
    });

    map.addLayer({
        id: 'gadm-ende-label',
        type: 'symbol',
        source: 'gadm-ende-source',
        layout: {
            'text-field': ['concat', 'Kec. ', ['get', 'NAME_3']],
            'text-size': 11,
            'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold']
        },
        paint: {
            'text-color': '#fde047',
            'text-halo-color': '#121212',
            'text-halo-width': 1.5
        }
    });
}

function openLayerLabelModal() {
    modalLayerLabel.show();
}

function applyLayerAndLabelSettings() {
    layerSettings.showMarkers = document.getElementById('layer-toggle-markers')?.checked ?? true;
    layerSettings.showShapes = document.getElementById('layer-toggle-shapes')?.checked ?? true;
    layerSettings.showGadm = document.getElementById('layer-toggle-gadm')?.checked ?? false;
    layerSettings.show3dBuildings = document.getElementById('layer-toggle-3d')?.checked ?? true;
    layerSettings.showLabels = document.getElementById('label-toggle-visible')?.checked ?? true;
    layerSettings.labelFontSize = parseInt(document.getElementById('label-font-size')?.value || '12', 10);
    layerSettings.labelMinZoom = parseFloat(document.getElementById('label-min-zoom')?.value || '11');
    layerSettings.labelTextColor = document.getElementById('label-text-color')?.value || '#ffffff';
    layerSettings.labelHaloColor = document.getElementById('label-halo-color')?.value || '#121212';
    layerSettings.labelAllowOverlap = document.getElementById('label-allow-overlap')?.checked ?? false;

    const lblSizeVal = document.getElementById('lbl-size-val');
    const lblZoomVal = document.getElementById('lbl-zoom-val');
    if (lblSizeVal) lblSizeVal.innerText = layerSettings.labelFontSize;
    if (lblZoomVal) lblZoomVal.innerText = layerSettings.labelMinZoom;

    renderGedung3DBawaan();
    renderGadmLayerToMap();
    renderObjekKePeta();
}

// ==========================================
// 6. SERVER DATA, MERGE DRAFT & RENDER PETA
// ==========================================
function getMergedActiveData() {
    // Gabungkan databaseUtama dengan draftSession berdasarkan ID (draft menimpa data lama)
    const markerMap = new Map();
    databaseUtama.markers.forEach(m => {
        if (m && m.ID) markerMap.set(String(m.ID), { ...m, isDraft: false });
    });
    draftSession.markers.forEach(m => {
        if (m && m.ID) markerMap.set(String(m.ID), { ...m, isDraft: true });
    });

    const shapeMap = new Map();
    databaseUtama.shapes.forEach(s => {
        if (s && s.ID) shapeMap.set(String(s.ID), { ...s, isDraft: false });
    });
    draftSession.shapes.forEach(s => {
        if (s && s.ID) shapeMap.set(String(s.ID), { ...s, isDraft: true });
    });

    const activeMarkers = Array.from(markerMap.values()).filter(m => String(m.Status || 'Active') !== 'Deleted');
    const activeShapes = Array.from(shapeMap.values()).filter(s => String(s.Status || 'Active') !== 'Deleted');

    return { markers: activeMarkers, shapes: activeShapes };
}

function populateCategoryOptions(extraCategories = null) {
    kategoriSelect.clearOptions();
    kategoriSelect.clearOptionGroups();

    const allCats = new Set();
    for (const [groupName, catArray] of Object.entries(defaultCategories)) {
        kategoriSelect.addOptionGroup(groupName, { label: groupName });
        catArray.forEach(cat => {
            kategoriSelect.addOption({ value: cat, text: cat, optgroup: groupName });
            allCats.add(cat);
        });
    }

    if (extraCategories && typeof extraCategories === 'object') {
        for (const [groupName, catArray] of Object.entries(extraCategories)) {
            kategoriSelect.addOptionGroup(groupName, { label: groupName });
            catArray.forEach(cat => {
                kategoriSelect.addOption({ value: cat, text: cat, optgroup: groupName });
                allCats.add(cat);
            });
        }
    }

    // Tambahkan kategori yang sudah ada di data
    const { markers, shapes } = getMergedActiveData();
    [...markers, ...shapes].forEach(item => {
        if (item.Kategori && !allCats.has(item.Kategori)) {
            kategoriSelect.addOption({ value: item.Kategori, text: item.Kategori });
            allCats.add(item.Kategori);
        }
    });

    // Isi dropdown filter kategori pada modal ekspor
    const expCatSelect = document.getElementById('export-category-select');
    if (expCatSelect) {
        expCatSelect.innerHTML = '';
        Array.from(allCats).sort().forEach(c => {
            const opt = document.createElement('option');
            opt.value = c;
            opt.textContent = c;
            expCatSelect.appendChild(opt);
        });
    }
}

async function ambilDataDariServer(isManualRefresh = false) {
    if (API_URL.includes('PASTE')) {
        document.getElementById('navigasi-container').innerHTML = '<div class="text-danger small p-2">Masukkan API_URL Apps Script pada konfigurasi!</div>';
        return;
    }

    setSyncIndicator('saving', 'Memuat...');
    try {
        const respon = await fetch(API_URL, { method: 'GET', cache: 'no-store' });
        if (!respon.ok) {
            throw new Error(`HTTP ${respon.status}`);
        }
        const rawData = await respon.json();
        if (rawData && rawData.status === 'error') {
            throw new Error(rawData.message || 'Respons server error');
        }

        databaseUtama.shapes = (rawData.shapes || []).filter(s => String(s.Status || 'Active') !== 'Deleted');
        databaseUtama.markers = (rawData.markers || []).filter(m => String(m.Status || 'Active') !== 'Deleted');

        populateCategoryOptions(rawData.categories);
        renderMenuKategori();
        renderObjekKePeta();
        updateSyncIndicatorFromState();

        if (isManualRefresh) {
            showToast(`Data berhasil disinkronkan (${databaseUtama.markers.length} titik, ${databaseUtama.shapes.length} area/jalur).`, 'success');
        }
    } catch (err) {
        populateCategoryOptions();
        renderMenuKategori();
        renderObjekKePeta();
        setSyncIndicator('error', 'Mode Offline / Cache');
        if (isManualRefresh) {
            showToast('Gagal menghubungi Google Spreadsheet. Menampilkan data lokal/draft yang tersedia.', 'warning');
        }
    }
}

function renderMenuKategori() {
    const wadah = document.getElementById('navigasi-container');
    if (!wadah) return;
    wadah.innerHTML = '';

    const { markers, shapes } = getMergedActiveData();
    const semuaData = [...shapes, ...markers];

    const totalCounter = document.getElementById('total-objek-counter');
    if (totalCounter) totalCounter.innerText = semuaData.length;

    const filterKeyword = (document.getElementById('sidebar-quick-filter')?.value || '').trim().toLowerCase();
    const filteredData = filterKeyword
        ? semuaData.filter(item =>
            String(item.Nama || '').toLowerCase().includes(filterKeyword) ||
            String(item.Kategori || '').toLowerCase().includes(filterKeyword) ||
            String(item.Deskripsi || '').toLowerCase().includes(filterKeyword)
        )
        : semuaData;

    if (filteredData.length === 0) {
        wadah.innerHTML = `<div class="text-secondary small p-2 text-center">${
            filterKeyword ? 'Tidak ada objek yang cocok dengan pencarian.' : 'Belum ada data tersimpan.'
        }</div>`;
        return;
    }

    const grupKategori = {};
    filteredData.forEach(item => {
        const kat = item.Kategori || 'Tanpa Kategori';
        if (!grupKategori[kat]) grupKategori[kat] = [];
        grupKategori[kat].push(item);
    });

    for (const [kategori, isiArray] of Object.entries(grupKategori)) {
        const btnKat = document.createElement('div');
        btnKat.className = 'kategori-header';
        const defColor = getDefaultColorByCategory(kategori).fill;
        btnKat.innerHTML = `
            <span class="text-truncate"><i class="fa-solid fa-layer-group me-2" style="color:${defColor}"></i> ${escapeHtml(kategori)}</span>
            <span class="d-flex align-items-center gap-2">
                <span class="badge bg-secondary rounded-pill" style="font-size:0.68rem;">${isiArray.length}</span>
                <i class="fa-solid fa-chevron-down small opacity-50"></i>
            </span>`;

        const subWadah = document.createElement('div');
        subWadah.className = 'submenu-container' + (filterKeyword || allCategoriesExpanded ? ' aktif' : '');

        isiArray.forEach(item => {
            const itemLok = document.createElement('div');
            itemLok.className = 'lokasi-item';
            const isMarker = item.Lat !== undefined && item.Lat !== '';
            const itemColor = item.Warna || item.WarnaArea || defColor;
            itemLok.style.borderLeftColor = itemColor;

            const ikon = isMarker ? (item.Icon || 'fa-location-dot') : (String(item.GeometryType || '').includes('Line') ? 'fa-route' : 'fa-draw-polygon');
            const statusBadge = item.isDraft
                ? '<span class="badge bg-warning text-dark ms-1" style="font-size:0.6rem;"><i class="fa-solid fa-clock me-1"></i>DRAFT</span>'
                : '<span class="badge bg-success bg-opacity-25 text-success ms-1" style="font-size:0.58rem;"><i class="fa-solid fa-check"></i></span>';

            itemLok.innerHTML = `
                <div class="d-flex align-items-center text-truncate" style="max-width: 82%;">
                    <div class="lokasi-icon" style="color:${itemColor};"><i class="fa-solid ${escapeHtml(ikon)}"></i></div>
                    <div class="text-truncate"><strong>${escapeHtml(item.Nama || 'Tanpa Nama')}</strong></div>
                </div>
                <div>${statusBadge}</div>`;
            itemLok.onclick = () => sorotDanTampilkanDetail(item);
            subWadah.appendChild(itemLok);
        });

        btnKat.onclick = () => subWadah.classList.toggle('aktif');
        wadah.appendChild(btnKat);
        wadah.appendChild(subWadah);
    }
}

function computeGeometryMetrics(geom) {
    let areaM2 = 0;
    let lengthM = 0;
    if (!geom || !geom.type) return { areaM2: 0, lengthM: 0 };
    try {
        const feat = { type: 'Feature', properties: {}, geometry: geom };
        if (geom.type.includes('Polygon')) {
            areaM2 = Number(turf.area(feat).toFixed(2));
            const line = turf.polygonToLine(feat);
            lengthM = Number((turf.length(line, { units: 'kilometers' }) * 1000).toFixed(2));
        } else if (geom.type.includes('LineString')) {
            lengthM = Number((turf.length(feat, { units: 'kilometers' }) * 1000).toFixed(2));
        }
    } catch (e) {
        // Fallback jika geometri belum lengkap
    }
    return { areaM2, lengthM };
}

function sorotDanTampilkanDetail(item) {
    if (!item) return;
    objekTerpilihSaatIni = item;

    let lng = 121.662, lat = -8.840, area = 0, lengthM = 0, geomType = 'Point';

    if (item.Lat !== undefined && item.Lat !== '') {
        lng = parseFloat(item.Lng);
        lat = parseFloat(item.Lat);
        geomType = 'Point';
    } else if (item.GeoJSON) {
        try {
            const geojsonObj = typeof item.GeoJSON === 'string' ? JSON.parse(item.GeoJSON) : item.GeoJSON;
            geomType = geojsonObj.type || 'Polygon';
            const p = turf.centroid({ type: 'Feature', properties: {}, geometry: geojsonObj });
            lng = p.geometry.coordinates[0];
            lat = p.geometry.coordinates[1];

            const metrics = computeGeometryMetrics(geojsonObj);
            area = metrics.areaM2;
            lengthM = metrics.lengthM;
        } catch (e) {
            console.warn('Gagal membaca GeoJSON objek:', e);
        }
    }

    if (map && isFinite(lng) && isFinite(lat)) {
        map.flyTo({ center: [lng, lat], zoom: 17, pitch: 50, duration: 1800, essential: true });
    }

    document.getElementById('detail-id').innerText = item.ID || '-';
    document.getElementById('detail-nama').innerText = item.Nama || 'Tanpa Nama';
    document.getElementById('detail-kategori').innerText = item.Kategori || '-';
    document.getElementById('detail-deskripsi').innerText = item.Deskripsi || 'Tidak ada keterangan detail.';
    document.getElementById('detail-koordinat').innerText = isFinite(lat) && isFinite(lng)
        ? `${lat.toFixed(6)}, ${lng.toFixed(6)}`
        : '-';

    const tstamp = item.Timestamp ? new Date(item.Timestamp).toLocaleString('id-ID') : 'Belum Sinkron';
    document.getElementById('detail-timestamp').innerText = tstamp;

    const statusEl = document.getElementById('detail-status');
    if (item.Status === 'Deleted') {
        statusEl.className = 'badge bg-danger';
        statusEl.innerHTML = '<i class="fa-solid fa-trash-can me-1"></i>Menunggu Hapus';
    } else if (item.isDraft) {
        statusEl.className = 'badge bg-warning text-dark';
        statusEl.innerHTML = '<i class="fa-solid fa-pen me-1"></i>Draft Lokal (Belum Disinkronkan)';
    } else {
        statusEl.className = 'badge bg-success';
        statusEl.innerHTML = '<i class="fa-solid fa-cloud-check me-1"></i>Tersinkronisasi';
    }

    const defColors = getDefaultColorByCategory(item.Kategori);
    const fillHex = item.WarnaArea || item.Warna || defColors.fill;
    const strokeHex = item.WarnaGaris || defColors.stroke;
    const fillOp = item.Opacity !== undefined && item.Opacity !== '' ? item.Opacity : 0.35;

    const geomContainer = document.getElementById('detail-geom-info');
    let geomHtml = '';
    if (geomType.includes('Polygon')) {
        const ha = (area / 10000).toFixed(3);
        geomHtml = `<i class="fa-solid fa-draw-polygon text-primary me-2"></i>Geometri: <b>Area Poligon</b><br>
                    <i class="fa-solid fa-ruler-combined text-primary me-2 mt-1"></i>Luas Valid: <b>${area.toLocaleString('id-ID')} m&sup2;</b> (${ha} Ha)<br>
                    <i class="fa-solid fa-ruler-horizontal text-primary me-2 mt-1"></i>Keliling: <b>${lengthM.toLocaleString('id-ID')} m</b><br>
                    <i class="fa-solid fa-fill-drip text-primary me-2 mt-1"></i>Warna Isian: <span class="badge" style="background:${fillHex};color:#fff;">${fillHex}</span> (Opacity: ${fillOp})`;
    } else if (geomType.includes('LineString')) {
        geomHtml = `<i class="fa-solid fa-route text-primary me-2"></i>Geometri: <b>Garis / Jalur</b><br>
                    <i class="fa-solid fa-ruler text-primary me-2 mt-1"></i>Panjang Valid: <b>${lengthM.toLocaleString('id-ID')} Meter</b> (${(lengthM / 1000).toFixed(3)} km)<br>
                    <i class="fa-solid fa-paint-roller text-primary me-2 mt-1"></i>Warna Garis: <span class="badge" style="background:${strokeHex};color:#000;">${strokeHex}</span> (${item.KetebalanGaris || 2.5}px)`;
    } else {
        const accBadge = item.AccuracyMeters ? ` | Akurasi GPS: &plusmn;${item.AccuracyMeters}m` : '';
        geomHtml = `<i class="fa-solid fa-location-dot text-primary me-2"></i>Geometri: <b>Titik Lokasi (Point)</b><br>
                    <i class="fa-solid fa-icons text-primary me-2 mt-1"></i>Ikon: <code>${escapeHtml(item.Icon || 'fa-location-dot')}</code> | Warna: <span class="badge" style="background:${fillHex};">${fillHex}</span>${accBadge}`;
    }
    geomContainer.innerHTML = geomHtml;

    document.getElementById('btn-zoom-obj').onclick = () => {
        if (map && isFinite(lng) && isFinite(lat)) map.flyTo({ center: [lng, lat], zoom: 18.5, pitch: 55 });
    };
    document.getElementById('btn-reshape-obj').onclick = () => startEditSelectedGeometry();
    document.getElementById('btn-edit-obj').onclick = () => prosesEditObjek(item);
    document.getElementById('btn-delete-obj').onclick = () => prosesHapusObjek(item);
    document.getElementById('detail-box').style.display = 'block';
}

function renderObjekKePeta() {
    const { markers, shapes } = getMergedActiveData();
    updateDynamicLegend(markers, shapes);

    if (!map || !map.isStyleLoaded()) return;

    // Bersihkan layer lama dengan aman
    ['label-objek-layer', 'garis-jalur', 'garis-poligon', 'fill-poligon'].forEach(layerId => {
        if (map.getLayer(layerId)) map.removeLayer(layerId);
    });
    ['sumber-label-objek', 'sumber-poligon'].forEach(srcId => {
        if (map.getSource(srcId)) map.removeSource(srcId);
    });

    // 1. Render Polygons & LineStrings dengan styling per-objek
    const shapeFeatures = [];
    const labelFeatures = [];

    if (layerSettings.showShapes) {
        shapes.forEach(s => {
            if (!s.GeoJSON) return;
            try {
                const geom = typeof s.GeoJSON === 'string' ? JSON.parse(s.GeoJSON) : s.GeoJSON;
                const defColor = getDefaultColorByCategory(s.Kategori);
                const fillColor = s.WarnaArea || defColor.fill;
                const lineColor = s.WarnaGaris || defColor.stroke;
                const fillOpacity = clampVal(s.Opacity, 0.05, 0.95, 0.35);
                const lineOpacity = clampVal(s.LineOpacity, 0.1, 1.0, 0.92);
                const lineWidth = clampVal(s.KetebalanGaris, 1, 12, 2.5);

                shapeFeatures.push({
                    type: 'Feature',
                    id: String(s.ID),
                    properties: {
                        ID: String(s.ID),
                        Nama: s.Nama || 'Tanpa Nama',
                        Kategori: s.Kategori || '',
                        fillColor: fillColor,
                        lineColor: lineColor,
                        fillOpacity: fillOpacity,
                        lineOpacity: lineOpacity,
                        lineWidth: lineWidth,
                        isPolygon: geom.type.includes('Polygon')
                    },
                    geometry: geom
                });

                // Titik tengah untuk label geografis shape
                const centerPt = turf.centroid({ type: 'Feature', properties: {}, geometry: geom });
                labelFeatures.push({
                    type: 'Feature',
                    properties: {
                        ID: String(s.ID),
                        labelName: truncateLabel(s.Nama || 'Tanpa Nama', 28),
                        priority: geom.type.includes('Polygon') ? 1 : 2,
                        offsetY: 0
                    },
                    geometry: centerPt.geometry
                });
            } catch (e) {
                console.warn('GeoJSON shape dilewati:', e);
            }
        });
    }

    map.addSource('sumber-poligon', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: shapeFeatures }
    });

    // Layer Fill khusus Polygon / MultiPolygon
    map.addLayer({
        id: 'fill-poligon',
        type: 'fill',
        source: 'sumber-poligon',
        filter: ['==', ['get', 'isPolygon'], true],
        paint: {
            'fill-color': ['get', 'fillColor'],
            'fill-opacity': ['get', 'fillOpacity']
        }
    });

    // Layer Outline khusus Polygon
    map.addLayer({
        id: 'garis-poligon',
        type: 'line',
        source: 'sumber-poligon',
        filter: ['==', ['get', 'isPolygon'], true],
        paint: {
            'line-color': ['get', 'lineColor'],
            'line-width': ['get', 'lineWidth'],
            'line-opacity': ['get', 'lineOpacity']
        }
    });

    // Layer Garis khusus LineString / Jalur
    map.addLayer({
        id: 'garis-jalur',
        type: 'line',
        source: 'sumber-poligon',
        filter: ['==', ['get', 'isPolygon'], false],
        layout: {
            'line-cap': 'round',
            'line-join': 'round'
        },
        paint: {
            'line-color': ['get', 'lineColor'],
            'line-width': ['get', 'lineWidth'],
            'line-opacity': ['get', 'lineOpacity']
        }
    });

    // Pasang event klik pada poligon & garis untuk membuka panel detail
    if (!map._shapeClickBound) {
        map._shapeClickBound = true;
        ['fill-poligon', 'garis-poligon', 'garis-jalur'].forEach(lid => {
            map.on('click', lid, (e) => {
                if (isMeasuring || isEditingExistingGeometry) return;
                if (e.features && e.features.length > 0) {
                    const clickedId = String(e.features[0].properties.ID);
                    const { shapes: activeShapes } = getMergedActiveData();
                    const found = activeShapes.find(item => String(item.ID) === clickedId);
                    if (found) sorotDanTampilkanDetail(found);
                }
            });
            map.on('mouseenter', lid, () => {
                if (!isMeasuring && !isEditingExistingGeometry) map.getCanvas().style.cursor = 'pointer';
            });
            map.on('mouseleave', lid, () => {
                if (!isMeasuring && !isEditingExistingGeometry) map.getCanvas().style.cursor = '';
            });
        });
    }

    // 2. Bersihkan marker lama secara menyeluruh (bebas memory leak)
    activeMapMarkers.forEach(mk => mk.remove());
    activeMapMarkers = [];

    if (layerSettings.showMarkers) {
        markers.forEach(m => {
            const lat = parseFloat(m.Lat);
            const lng = parseFloat(m.Lng);
            if (!isFinite(lat) || !isFinite(lng)) return;

            const defColor = getDefaultColorByCategory(m.Kategori).fill;
            const mColor = m.Warna || m.WarnaArea || defColor;
            const mSize = clampVal(m.UkuranMarker, 24, 56, 34);
            const iconClass = m.Icon || 'fa-location-dot';

            const el = document.createElement('div');
            el.className = `custom-marker ${m.isDraft ? 'marker-draft' : ''}`;
            el.style.width = `${mSize}px`;
            el.style.height = `${mSize}px`;
            el.style.borderColor = mColor;
            el.style.color = mColor;
            el.style.fontSize = `${Math.round(mSize * 0.44)}px`;
            el.title = `${m.Nama || 'Titik Lokasi'} (${m.Kategori || '-'})`;
            el.innerHTML = `<i class="fa-solid ${escapeHtml(iconClass)}"></i>${m.isDraft ? '<span class="marker-draft-badge" title="Draft"></span>' : ''}`;

            el.onclick = (ev) => {
                ev.stopPropagation();
                sorotDanTampilkanDetail(m);
            };

            const markerObj = new mapboxgl.Marker(el).setLngLat([lng, lat]).addTo(map);
            activeMapMarkers.push(markerObj);

            labelFeatures.push({
                type: 'Feature',
                properties: {
                    ID: String(m.ID),
                    labelName: truncateLabel(m.Nama || 'Tanpa Nama', 26),
                    priority: 3,
                    offsetY: 1.45
                },
                geometry: {
                    type: 'Point',
                    coordinates: [lng, lat]
                }
            });
        });
    }

    // 3. Render Layer Label Geografis (Mapbox Symbol Layer)
    if (layerSettings.showLabels && labelFeatures.length > 0) {
        map.addSource('sumber-label-objek', {
            type: 'geojson',
            data: { type: 'FeatureCollection', features: labelFeatures }
        });

        map.addLayer({
            id: 'label-objek-layer',
            type: 'symbol',
            source: 'sumber-label-objek',
            minzoom: layerSettings.labelMinZoom,
            layout: {
                'text-field': ['get', 'labelName'],
                'text-size': layerSettings.labelFontSize,
                'text-offset': [0, ['get', 'offsetY']],
                'text-anchor': 'top',
                'symbol-sort-key': ['get', 'priority'],
                'text-allow-overlap': layerSettings.labelAllowOverlap,
                'text-Optional': true
            },
            paint: {
                'text-color': layerSettings.labelTextColor,
                'text-halo-color': layerSettings.labelHaloColor,
                'text-halo-width': 1.8
            }
        });
    }
}

// ==========================================
// 6.1 LEGENDA DINAMIS
// ==========================================
function updateDynamicLegend(markers, shapes) {
    const legendContainer = document.getElementById('dynamic-legend-body');
    if (!legendContainer) return;

    const categorySummary = new Map();

    shapes.forEach(s => {
        const kat = s.Kategori || 'Area / Poligon';
        const color = s.WarnaArea || s.WarnaGaris || getDefaultColorByCategory(kat).fill;
        const isLine = String(s.GeometryType || '').includes('Line');
        const key = `${kat}_${isLine ? 'line' : 'poly'}`;
        if (!categorySummary.has(key)) {
            categorySummary.set(key, {
                label: kat,
                color: color,
                type: isLine ? 'Garis' : 'Area',
                icon: isLine ? 'fa-minus' : 'fa-square',
                count: 0
            });
        }
        categorySummary.get(key).count++;
    });

    markers.forEach(m => {
        const kat = m.Kategori || 'Titik Lokasi';
        const color = m.Warna || m.WarnaArea || getDefaultColorByCategory(kat).fill;
        const icon = m.Icon || 'fa-location-dot';
        const key = `${kat}_pt`;
        if (!categorySummary.has(key)) {
            categorySummary.set(key, {
                label: kat,
                color: color,
                type: 'Titik',
                icon: icon,
                count: 0
            });
        }
        categorySummary.get(key).count++;
    });

    if (categorySummary.size === 0) {
        legendContainer.innerHTML = `
            <div class="d-flex align-items-center mb-1"><i class="fa-solid fa-square me-2" style="color:rgba(13, 110, 253, 0.6);"></i> Area / Poligon</div>
            <div class="d-flex align-items-center"><i class="fa-solid fa-location-dot me-2 text-primary"></i> Titik Lokasi</div>`;
        return;
    }

    let html = '';
    categorySummary.forEach(entry => {
        html += `
            <div class="d-flex align-items-center justify-content-between mb-1 gap-2" style="font-size: 0.74rem;">
                <span class="text-truncate d-flex align-items-center">
                    <i class="fa-solid ${escapeHtml(entry.icon)} me-2" style="color:${entry.color}; width:14px; text-align:center;"></i>
                    <span class="text-truncate">${escapeHtml(entry.label)}</span>
                </span>
                <span class="badge bg-secondary bg-opacity-50" style="font-size:0.64rem;">${entry.count}</span>
            </div>`;
    });

    if (layerSettings.showGadm) {
        html += `
            <div class="d-flex align-items-center justify-content-between mb-1 gap-2" style="font-size: 0.74rem;">
                <span class="text-truncate d-flex align-items-center">
                    <i class="fa-solid fa-border-all me-2" style="color:#f59e0b; width:14px; text-align:center;"></i>
                    <span>Batas Kec. Ende (GADM)</span>
                </span>
                <span class="badge bg-warning text-dark" style="font-size:0.62rem;">Ref</span>
            </div>`;
    }

    legendContainer.innerHTML = html;
}

// ==========================================
// 7. ADMIN, OTENTIKASI, CRUD, AUTOSAVE & SYNC
// ==========================================
function prosesLogin() {
    const user = document.getElementById('login-user').value.trim();
    const pass = document.getElementById('login-pass').value;

    if (user === 'admin' && pass === 'stpm2026') {
        isAdmin = true;
        modalLogin.hide();
        document.getElementById('login-pass').value = '';

        document.getElementById('btn-login').classList.add('d-none');
        document.getElementById('btn-logout').classList.remove('d-none');
        document.getElementById('draft-box').classList.remove('d-none');
        document.getElementById('public-welcome-text').classList.add('d-none');

        document.querySelectorAll('.admin-only-tool').forEach(el => el.classList.remove('d-none'));
        document.querySelectorAll('.admin-only-group').forEach(el => el.classList.remove('d-none'));

        updateDraftCounterUI();
        if (map) map.flyTo({ pitch: 0, bearing: 0, duration: 1200 });
        showToast('Login berhasil. Mode Admin & Alat Pemetaan telah dibuka.', 'success');
    } else {
        showToast('Username atau Password salah!', 'danger');
    }
}

function logoutAdmin() {
    const totalDraft = draftSession.markers.length + draftSession.shapes.length;
    const performLogout = () => {
        isAdmin = false;
        if (drawControl) drawControl.deleteAll();
        hideDrawingBanner();
        closeGpsSurveyPanel();

        document.getElementById('btn-login').classList.remove('d-none');
        document.getElementById('btn-logout').classList.add('d-none');
        document.getElementById('draft-box').classList.add('d-none');
        document.getElementById('public-welcome-text').classList.remove('d-none');

        document.querySelectorAll('.admin-only-tool').forEach(el => el.classList.add('d-none'));
        document.querySelectorAll('.admin-only-group').forEach(el => el.classList.add('d-none'));

        showToast('Anda telah keluar dari Mode Admin.', 'info');
    };

    if (totalDraft > 0) {
        showConfirm(`Masih ada ${totalDraft} perubahan di Draft. Keluar dari Mode Admin sekarang? (Draft lokal tetap tersimpan di browser)`, performLogout);
    } else {
        performLogout();
    }
}

function tarikKoordinatPeta() {
    const coordInput = document.getElementById('form-koordinat');
    const latInput = document.getElementById('form-manual-lat');
    const lngInput = document.getElementById('form-manual-lng');

    if (fiturSedangDigambar && fiturSedangDigambar.geometry) {
        const t = fiturSedangDigambar.geometry.type;
        if (t === 'Point') {
            const lng = Number(fiturSedangDigambar.geometry.coordinates[0]);
            const lat = Number(fiturSedangDigambar.geometry.coordinates[1]);
            coordInput.value = `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
            if (latInput) latInput.value = lat.toFixed(6);
            if (lngInput) lngInput.value = lng.toFixed(6);
        } else {
            const p = turf.centroid(fiturSedangDigambar);
            const lng = Number(p.geometry.coordinates[0]);
            const lat = Number(p.geometry.coordinates[1]);
            coordInput.value = `${lat.toFixed(6)}, ${lng.toFixed(6)} (Pusat Area)`;
        }
        return;
    }

    if (map) {
        const c = map.getCenter();
        fiturSedangDigambar = {
            type: 'Feature',
            properties: {},
            geometry: { type: 'Point', coordinates: [c.lng, c.lat] }
        };
        coordInput.value = `${c.lat.toFixed(6)}, ${c.lng.toFixed(6)}`;
        if (latInput) latInput.value = c.lat.toFixed(6);
        if (lngInput) lngInput.value = c.lng.toFixed(6);
    }
}

function syncManualLatLngToForm() {
    const lat = parseFloat(document.getElementById('form-manual-lat')?.value);
    const lng = parseFloat(document.getElementById('form-manual-lng')?.value);
    if (isFinite(lat) && isFinite(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) {
        document.getElementById('form-koordinat').value = `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
        fiturSedangDigambar = {
            type: 'Feature',
            properties: (fiturSedangDigambar && fiturSedangDigambar.properties) || {},
            geometry: { type: 'Point', coordinates: [lng, lat] }
        };
    }
}

function fillFormWithGpsCoords() {
    if (!navigator.geolocation) {
        return showToast('Perangkat/browser tidak mendukung Geolocation. Gunakan input Lat/Lng manual.', 'warning');
    }
    showToast('Mengambil titik koordinat GPS perangkat...', 'info');
    navigator.geolocation.getCurrentPosition(
        (pos) => {
            const lat = pos.coords.latitude;
            const lng = pos.coords.longitude;
            const acc = pos.coords.accuracy;
            document.getElementById('form-koordinat').value = `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
            const latIn = document.getElementById('form-manual-lat');
            const lngIn = document.getElementById('form-manual-lng');
            if (latIn) latIn.value = lat.toFixed(6);
            if (lngIn) lngIn.value = lng.toFixed(6);

            fiturSedangDigambar = {
                type: 'Feature',
                properties: { Source: 'GPS', AccuracyMeters: Number(acc.toFixed(1)) },
                geometry: { type: 'Point', coordinates: [lng, lat] }
            };
            const accInfo = document.getElementById('form-gps-accuracy-info');
            if (accInfo) {
                accInfo.classList.remove('d-none');
                accInfo.innerHTML = `<i class="fa-solid fa-satellite-dish me-1"></i>Koordinat GPS diambil | Estimasi akurasi browser: <b>&plusmn;${acc.toFixed(1)} meter</b>.`;
            }
            if (map) map.flyTo({ center: [lng, lat], zoom: 17 });
        },
        (err) => {
            showToast('Gagal mengambil GPS: ' + getGeolocationErrorMessage(err), 'danger');
        },
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
    );
}

function batalGambarDraft() {
    if (drawControl) drawControl.deleteAll();
    if (tempPreviewMarker) {
        tempPreviewMarker.remove();
        tempPreviewMarker = null;
    }
    objekSedangDiedit = null;
    fiturSedangDigambar = null;
    modalDataInstance.hide();
}

function prosesEditObjek(item) {
    if (!isAdmin) return showToast('Silakan Login Admin untuk mengedit objek.', 'warning');
    objekSedangDiedit = { ...item };
    fiturSedangDigambar = null;

    const alertEl = document.getElementById('form-validation-alert');
    if (alertEl) alertEl.classList.add('d-none');

    document.getElementById('modal-data-title').innerHTML = `<i class="fa-solid fa-pen-to-square text-warning me-2"></i>Edit Objek: ${escapeHtml(item.Nama || '')}`;
    document.getElementById('form-nama').value = item.Nama || '';
    document.getElementById('form-deskripsi').value = item.Deskripsi || '';

    if (item.Kategori) {
        kategoriSelect.addOption({ value: item.Kategori, text: item.Kategori });
        kategoriSelect.setValue(item.Kategori, true);
    }

    const isMarker = item.Lat !== undefined && item.Lat !== '';
    const defColors = getDefaultColorByCategory(item.Kategori);
    const fillHex = item.Warna || item.WarnaArea || defColors.fill;
    const strokeHex = item.WarnaGaris || defColors.stroke;

    setFormColors(fillHex, strokeHex);

    if (isMarker) {
        iconSelect.setValue(item.Icon || 'fa-location-dot', true);
        document.getElementById('form-ukuran-marker').value = item.UkuranMarker || 34;
        document.getElementById('group-marker-options').style.display = 'block';
        document.getElementById('group-shape-sliders').style.display = 'none';
        document.getElementById('group-warna-garis').style.display = 'none';
        document.getElementById('manual-latlng-row').style.display = 'flex';
        document.getElementById('form-koordinat').value = `${Number(item.Lat).toFixed(6)}, ${Number(item.Lng).toFixed(6)}`;
        document.getElementById('form-manual-lat').value = Number(item.Lat).toFixed(6);
        document.getElementById('form-manual-lng').value = Number(item.Lng).toFixed(6);
    } else {
        document.getElementById('group-marker-options').style.display = 'none';
        document.getElementById('group-shape-sliders').style.display = 'flex';
        document.getElementById('group-warna-garis').style.display = 'block';
        document.getElementById('manual-latlng-row').style.display = 'none';
        document.getElementById('form-opacity').value = item.Opacity !== undefined && item.Opacity !== '' ? item.Opacity : 0.35;
        document.getElementById('form-ketebalan-garis').value = item.KetebalanGaris || 2.5;
        document.getElementById('form-koordinat').value = 'Geometri Area/Jalur Aktif (Gunakan tombol Edit Geometri untuk geser titik)';
    }

    updateStylePreview();
    closeDetailBox();
    modalDataInstance.show();
}

function upsertItemIntoDraft(obj, isMarker) {
    const targetArr = isMarker ? draftSession.markers : draftSession.shapes;
    const idx = targetArr.findIndex(x => String(x.ID) === String(obj.ID));
    const readyObj = {
        ...obj,
        isDraft: true,
        UpdatedAt: new Date().toISOString(),
        ClientId: getClientId()
    };
    if (idx > -1) {
        targetArr[idx] = readyObj;
    } else {
        targetArr.push(readyObj);
    }
    persistLocalDraftQueue();
    updateDraftCounterUI();
    scheduleAutoSyncIfNeeded();
}

function prosesHapusObjek(item) {
    if (!isAdmin) return showToast('Hanya Admin yang dapat menghapus data.', 'warning');
    showConfirm(`Tandai objek "${item.Nama}" sebagai dihapus (Soft Delete)? Objek akan disembunyikan dari peta dan diperbarui ke Spreadsheet saat disimpan.`, () => {
        pushUndoSnapshot();
        const isMarker = item.Lat !== undefined && item.Lat !== '';
        const deletedObj = {
            ...item,
            Status: 'Deleted',
            isDraft: true,
            UpdatedAt: new Date().toISOString(),
            ClientId: getClientId()
        };

        upsertItemIntoDraft(deletedObj, isMarker);
        if (objekTerpilihSaatIni && String(objekTerpilihSaatIni.ID) === String(item.ID)) {
            objekTerpilihSaatIni = null;
        }
        closeDetailBox();
        renderMenuKategori();
        renderObjekKePeta();
        showToast(`Objek "${item.Nama}" ditandai untuk dihapus (Soft Delete).`, 'warning');
    });
}

function simpanKeDraftMemori() {
    const nama = document.getElementById('form-nama').value.trim();
    const kategori = (kategoriSelect.getValue() || document.getElementById('form-kategori').value || '').trim();
    const deskripsi = document.getElementById('form-deskripsi').value.trim();
    const alertEl = document.getElementById('form-validation-alert');

    if (!nama) {
        if (alertEl) {
            alertEl.innerText = 'Nama Objek wajib diisi.';
            alertEl.classList.remove('d-none');
        }
        return;
    }
    if (!kategori) {
        if (alertEl) {
            alertEl.innerText = 'Pilih atau ketik Kategori terlebih dahulu.';
            alertEl.classList.remove('d-none');
        }
        return;
    }

    const warnaArea = document.getElementById('form-warna-area').value || '#0d6efd';
    const warnaGaris = document.getElementById('form-warna-garis').value || '#6ea8fe';
    const opacity = parseFloat(document.getElementById('form-opacity').value || '0.35');
    const ketebalanGaris = parseFloat(document.getElementById('form-ketebalan-garis').value || '2.5');
    const ukuranMarker = parseInt(document.getElementById('form-ukuran-marker').value || '34', 10);
    const iconVal = iconSelect.getValue() || 'fa-location-dot';
    const nowIso = new Date().toISOString();

    pushUndoSnapshot();

    if (objekSedangDiedit) {
        const isMarker = objekSedangDiedit.Lat !== undefined && objekSedangDiedit.Lat !== '';
        const updatedObj = {
            ...objekSedangDiedit,
            Nama: nama,
            Kategori: kategori,
            Deskripsi: deskripsi,
            Status: 'Active',
            Timestamp: nowIso,
            UpdatedAt: nowIso
        };

        if (isMarker) {
            const manualLat = parseFloat(document.getElementById('form-manual-lat').value);
            const manualLng = parseFloat(document.getElementById('form-manual-lng').value);
            if (isFinite(manualLat) && isFinite(manualLng)) {
                updatedObj.Lat = Number(manualLat.toFixed(6));
                updatedObj.Lng = Number(manualLng.toFixed(6));
            }
            updatedObj.Icon = iconVal;
            updatedObj.Warna = warnaArea;
            updatedObj.UkuranMarker = ukuranMarker;
            upsertItemIntoDraft(updatedObj, true);
        } else {
            updatedObj.WarnaArea = warnaArea;
            updatedObj.WarnaGaris = warnaGaris;
            updatedObj.Opacity = opacity;
            updatedObj.KetebalanGaris = ketebalanGaris;
            upsertItemIntoDraft(updatedObj, false);
        }

        objekSedangDiedit = null;
        showToast('Perubahan atribut & styling berhasil disimpan ke Draft.', 'success');
    } else {
        // Objek Baru
        if (!fiturSedangDigambar) {
            syncManualLatLngToForm();
        }
        if (!fiturSedangDigambar || !fiturSedangDigambar.geometry) {
            if (alertEl) {
                alertEl.innerText = 'Koordinat atau geometri belum diambil. Klik Ambil atau masukkan Lat/Lng.';
                alertEl.classList.remove('d-none');
            }
            return;
        }

        const newId = Date.now().toString() + '_' + Math.floor(Math.random() * 1000);
        const props = fiturSedangDigambar.properties || {};

        if (fiturSedangDigambar.geometry.type === 'Point') {
            const lng = Number(fiturSedangDigambar.geometry.coordinates[0]);
            const lat = Number(fiturSedangDigambar.geometry.coordinates[1]);
            const markerBaru = {
                ID: newId,
                Nama: nama,
                Kategori: kategori,
                Deskripsi: deskripsi,
                Icon: iconVal,
                Lat: Number(lat.toFixed(6)),
                Lng: Number(lng.toFixed(6)),
                Warna: warnaArea,
                UkuranMarker: ukuranMarker,
                Status: 'Active',
                Timestamp: nowIso,
                CreatedAt: nowIso,
                UpdatedAt: nowIso,
                Source: props.Source || 'WebGIS',
                AccuracyMeters: props.AccuracyMeters || '',
                ClientId: getClientId()
            };
            upsertItemIntoDraft(markerBaru, true);
        } else {
            const metrics = computeGeometryMetrics(fiturSedangDigambar.geometry);
            const shapeBaru = {
                ID: newId,
                Nama: nama,
                Kategori: kategori,
                Deskripsi: deskripsi,
                WarnaArea: warnaArea,
                WarnaGaris: warnaGaris,
                Opacity: opacity,
                KetebalanGaris: ketebalanGaris,
                LineOpacity: 0.92,
                GeoJSON: JSON.stringify(fiturSedangDigambar.geometry),
                GeometryType: fiturSedangDigambar.geometry.type,
                LuasM2: metrics.areaM2,
                PanjangM: metrics.lengthM,
                Status: 'Active',
                Timestamp: nowIso,
                CreatedAt: nowIso,
                UpdatedAt: nowIso,
                Source: props.Source || 'WebGIS',
                ClientId: getClientId()
            };
            upsertItemIntoDraft(shapeBaru, false);
        }
        fiturSedangDigambar = null;
        showToast('Objek baru berhasil masuk ke antrean Draft.', 'success');
    }

    if (tempPreviewMarker) {
        tempPreviewMarker.remove();
        tempPreviewMarker = null;
    }

    modalDataInstance.hide();
    if (drawControl) drawControl.deleteAll();
    populateCategoryOptions();
    renderMenuKategori();
    renderObjekKePeta();
}

// ==========================================
// 7.1 MEKANISME SINKRONISASI & AUTOSAVE AMAN
// ==========================================
function persistLocalDraftQueue() {
    safeStorageSet(STORAGE_KEYS.DRAFT_QUEUE, JSON.stringify(draftSession));
}

function restoreLocalDraftQueue() {
    const raw = safeStorageGet(STORAGE_KEYS.DRAFT_QUEUE);
    if (!raw) return;
    try {
        const parsed = JSON.parse(raw);
        if (parsed && (Array.isArray(parsed.markers) || Array.isArray(parsed.shapes))) {
            draftSession.markers = Array.isArray(parsed.markers) ? parsed.markers : [];
            draftSession.shapes = Array.isArray(parsed.shapes) ? parsed.shapes : [];
            updateDraftCounterUI();
        }
    } catch (e) {
        // Abaikan jika korup
    }
}

function updateDraftCounterUI() {
    const total = draftSession.markers.length + draftSession.shapes.length;
    const counterEl = document.getElementById('draft-counter');
    if (counterEl) {
        const delCount = [...draftSession.markers, ...draftSession.shapes].filter(x => x.Status === 'Deleted').length;
        counterEl.innerText = delCount > 0
            ? `${total} Antrean Perubahan (${delCount} Hapus)`
            : `${total} Objek Draft`;
    }
    updateSyncIndicatorFromState();
}

function setSyncIndicator(state, text) {
    const badge = document.getElementById('sync-status-indicator');
    const txtEl = document.getElementById('sync-status-text');
    const retryBtn = document.getElementById('btn-retry-sync');
    if (!badge || !txtEl) return;

    badge.className = 'sync-status-badge';
    if (state === 'saved') {
        badge.classList.add('sync-saved');
        badge.innerHTML = `<i class="fa-solid fa-cloud-check"></i> <span id="sync-status-text">${text || 'Tersimpan'}</span>`;
        if (retryBtn) retryBtn.classList.add('d-none');
    } else if (state === 'pending') {
        badge.classList.add('sync-pending');
        badge.innerHTML = `<i class="fa-solid fa-clock"></i> <span id="sync-status-text">${text || 'Perlu Sinkronisasi'}</span>`;
    } else if (state === 'saving') {
        badge.classList.add('sync-saving');
        badge.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> <span id="sync-status-text">${text || 'Menyimpan...'}</span>`;
    } else if (state === 'error') {
        badge.classList.add('sync-error');
        badge.innerHTML = `<i class="fa-solid fa-triangle-exclamation"></i> <span id="sync-status-text">${text || 'Gagal Sinkron'}</span>`;
        if (retryBtn && (draftSession.markers.length + draftSession.shapes.length) > 0) {
            retryBtn.classList.remove('d-none');
        }
    }
}

function updateSyncIndicatorFromState() {
    const total = draftSession.markers.length + draftSession.shapes.length;
    if (total > 0) {
        setSyncIndicator('pending', `${total} Menunggu Sinkron`);
    } else {
        setSyncIndicator('saved', 'Tersimpan');
    }
}

function toggleAutoSyncSetting(checked) {
    autoSyncEnabled = Boolean(checked);
    safeStorageSet(STORAGE_KEYS.AUTOSYNC, autoSyncEnabled ? 'true' : 'false');
    showToast(autoSyncEnabled
        ? 'Auto-Sync diaktifkan: perubahan draft akan disinkronkan otomatis ke Spreadsheet.'
        : 'Auto-Sync dinonaktifkan: gunakan tombol Simpan Permanen.', 'info');
    if (autoSyncEnabled) {
        scheduleAutoSyncIfNeeded();
    }
}

function scheduleAutoSyncIfNeeded() {
    if (!autoSyncEnabled) return;
    if (autoSyncTimer) clearTimeout(autoSyncTimer);
    autoSyncTimer = setTimeout(() => {
        const total = draftSession.markers.length + draftSession.shapes.length;
        if (total > 0 && !isSyncInProgress) {
            performServerSync(true);
        }
    }, 3500);
}

function kirimDraftKeServer() {
    const total = draftSession.markers.length + draftSession.shapes.length;
    if (total === 0) return showToast('Belum ada perubahan draft untuk disimpan.', 'warning');
    if (isSyncInProgress) return showToast('Sinkronisasi sedang berjalan, harap tunggu...', 'info');

    showConfirm(`Kirim permanen ${total} perubahan objek ke Google Spreadsheet sekarang?`, () => {
        performServerSync(false);
    });
}

function retryFailedSync() {
    if (isSyncInProgress) return;
    performServerSync(false);
}

async function performServerSync(isSilentAutoSync = false) {
    const total = draftSession.markers.length + draftSession.shapes.length;
    if (total === 0 || isSyncInProgress) return;

    isSyncInProgress = true;
    setSyncIndicator('saving', 'Menyimpan...');
    const counterEl = document.getElementById('draft-counter');
    if (counterEl) {
        counterEl.innerHTML = '<i class="fa-solid fa-spinner fa-spin me-1"></i> Mengirim ke Spreadsheet...';
    }

    const payloadToSync = {
        action: 'save_bulk',
        actor: isAdmin ? 'admin' : 'visitor',
        clientTimestamp: new Date().toISOString(),
        data: {
            markers: [...draftSession.markers],
            shapes: [...draftSession.shapes]
        }
    };

    try {
        const respon = await fetch(API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain;charset=utf-8' },
            body: JSON.stringify(payloadToSync)
        });

        if (!respon.ok) {
            throw new Error(`Server merespons dengan status HTTP ${respon.status}`);
        }

        const textBody = await respon.text();
        let parsedJson = null;
        try {
            parsedJson = JSON.parse(textBody);
        } catch (jsonErr) {
            throw new Error('Respons server bukan JSON yang valid. Periksa deployment Google Apps Script.');
        }

        if (!parsedJson || (parsedJson.status !== 'success' && parsedJson.ok !== true)) {
            const errMsg = (parsedJson && parsedJson.message) ? parsedJson.message : 'Server menolak penyimpanan.';
            throw new Error(errMsg);
        }

        // Sukses terkonfirmasi oleh server: gabungkan perubahan ke databaseUtama & bersihkan antrean lokal
        const syncedMarkerIds = new Set(payloadToSync.data.markers.map(m => String(m.ID)));
        const syncedShapeIds = new Set(payloadToSync.data.shapes.map(s => String(s.ID)));

        // Perbarui databaseUtama tanpa me-reload seluruh halaman
        const mergedAfterSync = getMergedActiveData();
        databaseUtama.markers = mergedAfterSync.markers.map(m => ({ ...m, isDraft: false }));
        databaseUtama.shapes = mergedAfterSync.shapes.map(s => ({ ...s, isDraft: false }));

        // Bersihkan item yang sudah berhasil dikirim dari draftSession
        draftSession.markers = draftSession.markers.filter(m => !syncedMarkerIds.has(String(m.ID)));
        draftSession.shapes = draftSession.shapes.filter(s => !syncedShapeIds.has(String(s.ID)));
        persistLocalDraftQueue();

        syncRetryCount = 0;
        isSyncInProgress = false;
        updateDraftCounterUI();
        renderMenuKategori();
        renderObjekKePeta();

        if (!isSilentAutoSync) {
            showToast(`Berhasil menyimpan ${total} perubahan ke Google Spreadsheet!`, 'success');
        }
    } catch (err) {
        isSyncInProgress = false;
        setSyncIndicator('error', 'Gagal Sinkron');
        const totalRemaining = draftSession.markers.length + draftSession.shapes.length;
        if (counterEl) {
            counterEl.innerText = `${totalRemaining} Antrean (Gagal Terkirim)`;
        }

        // Jadwalkan retry otomatis dengan backoff jika dalam mode auto-sync
        if (autoSyncEnabled && syncRetryCount < MAX_SYNC_RETRIES) {
            syncRetryCount++;
            const backoffMs = Math.pow(2, syncRetryCount) * 2500;
            setTimeout(() => performServerSync(true), backoffMs);
        }

        showToast(`Penyimpanan ke Spreadsheet gagal: ${err.message}. Data tetap aman di Draft lokal — klik "Coba Lagi" saat koneksi pulih.`, 'danger');
    }
}

// ==========================================
// 8. GPS & PEMETAAN LAPANGAN LANGSUNG
// ==========================================
function getGeolocationErrorMessage(err) {
    if (!window.isSecureContext && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
        return 'Geolocation membutuhkan koneksi aman HTTPS atau localhost.';
    }
    if (!err) return 'Kesalahan tidak diketahui pada layanan lokasi.';
    switch (err.code) {
        case 1: return 'Izin akses lokasi ditolak oleh pengguna. Aktifkan izin lokasi di pengaturan browser.';
        case 2: return 'Posisi perangkat tidak tersedia (sinyal GPS/jaringan lemah).';
        case 3: return 'Waktu permintaan lokasi habis (Timeout). Coba lagi di area terbuka.';
        default: return err.message || 'Gagal memperoleh lokasi perangkat.';
    }
}

function updateGpsPanelUI(pos, statusText, badgeClass = 'bg-success') {
    const statusBadge = document.getElementById('gps-status-badge');
    const coordsEl = document.getElementById('gps-current-coords');
    const accEl = document.getElementById('gps-current-accuracy');

    if (statusBadge && statusText) {
        statusBadge.className = `badge ${badgeClass}`;
        statusBadge.innerText = statusText;
    }

    if (pos && pos.coords) {
        const lat = pos.coords.latitude;
        const lng = pos.coords.longitude;
        const acc = pos.coords.accuracy;
        gpsState.lastPosition = { lat, lng, accuracy: acc, timestamp: Date.now() };
        if (coordsEl) coordsEl.innerText = `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
        if (accEl) {
            accEl.innerText = `\u00B1${acc.toFixed(1)} meter`;
            accEl.className = `badge ${acc <= 15 ? 'bg-success' : (acc <= 40 ? 'bg-info text-dark' : 'bg-warning text-dark')}`;
        }
    }
}

function renderLiveGpsMarker(lng, lat) {
    if (!map) return;
    if (tempGpsMarker) tempGpsMarker.remove();
    const el = document.createElement('div');
    el.className = 'gps-live-marker';
    el.title = `Posisi GPS Anda (${lat.toFixed(6)}, ${lng.toFixed(6)})`;
    tempGpsMarker = new mapboxgl.Marker(el).setLngLat([lng, lat]).addTo(map);
}

function openGpsSurveyPanel() {
    const panel = document.getElementById('gps-survey-panel');
    if (panel) panel.style.display = 'block';
    if (!navigator.geolocation) {
        updateGpsPanelUI(null, 'Tidak Didukung Browser', 'bg-danger');
        showToast('Browser ini tidak mendukung Geolocation API. Anda tetap dapat memasukkan koordinat secara manual.', 'warning');
    }
}

function closeGpsSurveyPanel() {
    if (gpsState.isRecording) {
        showConfirm('Perekaman jejak GPS masih berjalan. Hentikan rekaman dan tutup panel?', () => {
            stopGpsTrackRecording();
            document.getElementById('gps-survey-panel').style.display = 'none';
        });
        return;
    }
    const panel = document.getElementById('gps-survey-panel');
    if (panel) panel.style.display = 'none';
}

function locateUser(openPanel = false) {
    if (openPanel) openGpsSurveyPanel();
    if (!navigator.geolocation) {
        updateGpsPanelUI(null, 'Geolocation Tidak Tersedia', 'bg-danger');
        return showToast('Browser Anda tidak mendukung Geolocation.', 'danger');
    }

    updateGpsPanelUI(null, 'Mengambil Lokasi...', 'bg-info text-dark');
    navigator.geolocation.getCurrentPosition(
        (pos) => {
            const { latitude: lat, longitude: lng, accuracy: acc } = pos.coords;
            updateGpsPanelUI(pos, 'Lokasi Ditemukan', 'bg-success');
            renderLiveGpsMarker(lng, lat);
            if (map) map.flyTo({ center: [lng, lat], zoom: 17.5, pitch: 0 });
            showToast(`Lokasi ditemukan (${lat.toFixed(5)}, ${lng.toFixed(5)} | Estimasi akurasi \u00B1${acc.toFixed(1)}m).`, 'success');
        },
        (err) => {
            const msg = getGeolocationErrorMessage(err);
            updateGpsPanelUI(null, 'Gagal / Ditolak', 'bg-danger');
            showToast(msg, 'danger');
        },
        { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 }
    );
}

function centerMapToLastGps() {
    if (gpsState.lastPosition && map) {
        map.flyTo({ center: [gpsState.lastPosition.lng, gpsState.lastPosition.lat], zoom: 18 });
    } else {
        locateUser(false);
    }
}

function addPointFromMyLocation() {
    if (!isAdmin) {
        showToast('Silakan Login Admin terlebih dahulu untuk menambahkan objek dari GPS.', 'warning');
        modalLogin.show();
        return;
    }
    if (!navigator.geolocation) {
        return showToast('Geolocation tidak tersedia. Gunakan formulir manual.', 'danger');
    }

    updateGpsPanelUI(null, 'Mengambil Titik GPS...', 'bg-info text-dark');
    navigator.geolocation.getCurrentPosition(
        (pos) => {
            const { latitude: lat, longitude: lng, accuracy: acc } = pos.coords;
            updateGpsPanelUI(pos, 'Titik Siap Disimpan', 'bg-success');
            renderLiveGpsMarker(lng, lat);
            if (map) map.flyTo({ center: [lng, lat], zoom: 18, pitch: 0 });

            const feature = {
                type: 'Feature',
                properties: { Source: 'GPS_Point', AccuracyMeters: Number(acc.toFixed(1)) },
                geometry: { type: 'Point', coordinates: [lng, lat] }
            };
            openFormForNewFeature(feature, 'GPS Perangkat', acc);
        },
        (err) => {
            const msg = getGeolocationErrorMessage(err);
            updateGpsPanelUI(null, 'Gagal Mengambil Titik', 'bg-danger');
            showToast(msg, 'danger');
        },
        { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 }
    );
}

// Perekaman Jejak / Area Survei Lapangan GPS
function startGpsTrackRecording() {
    if (!isAdmin) {
        showToast('Silakan Login Admin terlebih dahulu untuk merekam survei lapangan.', 'warning');
        modalLogin.show();
        return;
    }
    if (!navigator.geolocation) {
        return showToast('Perangkat/browser tidak mendukung Geolocation.', 'danger');
    }
    if (gpsState.isRecording) return;

    gpsState.isRecording = true;
    gpsState.startTime = Date.now();

    document.getElementById('btn-start-gps-record').disabled = true;
    document.getElementById('btn-stop-gps-record').disabled = false;
    document.getElementById('btn-sample-gps-point').disabled = false;
    updateGpsPanelUI(null, 'Merekam Jejak GPS...', 'bg-warning text-dark');

    if (gpsState.timerInterval) clearInterval(gpsState.timerInterval);
    gpsState.timerInterval = setInterval(() => {
        const elapsedSec = Math.floor((Date.now() - gpsState.startTime) / 1000);
        const mins = String(Math.floor(elapsedSec / 60)).padStart(2, '0');
        const secs = String(elapsedSec % 60).padStart(2, '0');
        const timerEl = document.getElementById('gps-track-timer');
        if (timerEl) timerEl.innerText = `${mins}:${secs}`;
    }, 1000);

    gpsState.watchId = navigator.geolocation.watchPosition(
        (pos) => {
            updateGpsPanelUI(pos, 'Merekam Aktif', 'bg-success');
            const { latitude: lat, longitude: lng, accuracy: acc } = pos.coords;
            renderLiveGpsMarker(lng, lat);

            const maxAcc = parseFloat(document.getElementById('gps-max-accuracy')?.value || '50');
            const minDist = parseFloat(document.getElementById('gps-min-distance')?.value || '3');

            if (isFinite(maxAcc) && acc > maxAcc && gpsState.samples.length > 0) {
                return; // Abaikan sampel yang akurasinya di luar ambang batas
            }

            if (gpsState.samples.length > 0 && isFinite(minDist) && minDist > 0) {
                const prev = gpsState.samples[gpsState.samples.length - 1];
                const distMeters = turf.distance(
                    turf.point([prev.lng, prev.lat]),
                    turf.point([lng, lat]),
                    { units: 'kilometers' }
                ) * 1000;
                if (distMeters < minDist) return;
            }

            appendGpsSample({ lat, lng, accuracy: Number(acc.toFixed(1)), timestamp: new Date().toISOString() });
        },
        (err) => {
            showToast('Peringatan GPS: ' + getGeolocationErrorMessage(err), 'warning');
        },
        { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
    );

    showToast('Perekaman survei GPS dimulai. Berjalanlah mengikuti batas wilayah atau klik "+ Titik".', 'info');
}

function recordManualGpsSample() {
    if (gpsState.lastPosition) {
        appendGpsSample({
            lat: gpsState.lastPosition.lat,
            lng: gpsState.lastPosition.lng,
            accuracy: Number((gpsState.lastPosition.accuracy || 10).toFixed(1)),
            timestamp: new Date().toISOString()
        });
    } else if (map) {
        // Fallback titik tengah peta jika sedang simulasi di meja kerja
        const c = map.getCenter();
        appendGpsSample({
            lat: Number(c.lat.toFixed(6)),
            lng: Number(c.lng.toFixed(6)),
            accuracy: 5.0,
            timestamp: new Date().toISOString()
        });
    }
}

function appendGpsSample(sample) {
    gpsState.samples.push(sample);
    renderGpsSamplesListUI();
    renderGpsTrackOnMap();
}

function removeGpsSampleAt(index) {
    gpsState.samples.splice(index, 1);
    renderGpsSamplesListUI();
    renderGpsTrackOnMap();
}

function clearGpsTrackSamples() {
    gpsState.samples = [];
    renderGpsSamplesListUI();
    renderGpsTrackOnMap();
}

function stopGpsTrackRecording() {
    if (gpsState.watchId !== null && navigator.geolocation) {
        navigator.geolocation.clearWatch(gpsState.watchId);
        gpsState.watchId = null;
    }
    if (gpsState.timerInterval) {
        clearInterval(gpsState.timerInterval);
        gpsState.timerInterval = null;
    }
    gpsState.isRecording = false;

    const btnStart = document.getElementById('btn-start-gps-record');
    const btnStop = document.getElementById('btn-stop-gps-record');
    const btnSample = document.getElementById('btn-sample-gps-point');
    if (btnStart) btnStart.disabled = false;
    if (btnStop) btnStop.disabled = true;
    if (btnSample) btnSample.disabled = true;

    updateGpsPanelUI(null, 'Rekaman Dihentikan', 'bg-secondary');
    renderGpsSamplesListUI();
}

function renderGpsSamplesListUI() {
    const countEl = document.getElementById('gps-sample-count');
    const listEl = document.getElementById('gps-samples-list');
    const btnFinish = document.getElementById('btn-finish-gps-survey');
    const geomType = document.getElementById('gps-survey-geom-type')?.value || 'Polygon';

    const count = gpsState.samples.length;
    if (countEl) countEl.innerText = count;

    const minRequired = geomType === 'Polygon' ? 3 : 2;
    if (btnFinish) btnFinish.disabled = count < minRequired;

    if (!listEl) return;
    if (count === 0) {
        listEl.innerHTML = '<div class="text-secondary fst-italic text-center py-2">Belum ada sampel koordinat terekam.</div>';
        return;
    }

    let html = '';
    gpsState.samples.forEach((s, idx) => {
        html += `
            <div class="d-flex justify-content-between align-items-center py-1 px-1 border-bottom border-secondary border-opacity-10">
                <span class="font-monospace">#${idx + 1}: ${s.lat.toFixed(5)}, ${s.lng.toFixed(5)} (&plusmn;${s.accuracy}m)</span>
                <button type="button" class="btn btn-link btn-sm p-0 text-danger" onclick="removeGpsSampleAt(${idx})" title="Hapus titik ini">
                    <i class="fa-solid fa-xmark"></i>
                </button>
            </div>`;
    });
    listEl.innerHTML = html;
}

function renderGpsTrackOnMap() {
    if (!map || !map.isStyleLoaded()) return;

    ['gps-track-points', 'gps-track-line', 'gps-track-fill'].forEach(lid => {
        if (map.getLayer(lid)) map.removeLayer(lid);
    });
    if (map.getSource('gps-track-source')) map.removeSource('gps-track-source');

    if (gpsState.samples.length === 0) return;

    const coords = gpsState.samples.map(s => [s.lng, s.lat]);
    const features = gpsState.samples.map((s, idx) => ({
        type: 'Feature',
        properties: { idx: idx + 1 },
        geometry: { type: 'Point', coordinates: [s.lng, s.lat] }
    }));

    if (coords.length >= 2) {
        features.push({
            type: 'Feature',
            properties: { isTrackLine: true },
            geometry: { type: 'LineString', coordinates: coords }
        });
    }

    const geomType = document.getElementById('gps-survey-geom-type')?.value || 'Polygon';
    if (geomType === 'Polygon' && coords.length >= 3) {
        const closedRing = [...coords, coords[0]];
        features.push({
            type: 'Feature',
            properties: { isTrackPoly: true },
            geometry: { type: 'Polygon', coordinates: [closedRing] }
        });
    }

    map.addSource('gps-track-source', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features }
    });

    map.addLayer({
        id: 'gps-track-fill',
        type: 'fill',
        source: 'gps-track-source',
        filter: ['==', ['get', 'isTrackPoly'], true],
        paint: { 'fill-color': '#10b981', 'fill-opacity': 0.28 }
    });

    map.addLayer({
        id: 'gps-track-line',
        type: 'line',
        source: 'gps-track-source',
        filter: ['==', ['get', 'isTrackLine'], true],
        paint: { 'line-color': '#10b981', 'line-width': 3, 'line-dasharray': [2, 1] }
    });

    map.addLayer({
        id: 'gps-track-points',
        type: 'circle',
        source: 'gps-track-source',
        filter: ['has', 'idx'],
        paint: {
            'circle-radius': 5,
            'circle-color': '#ffffff',
            'circle-stroke-color': '#10b981',
            'circle-stroke-width': 2
        }
    });
}

function finishAndSaveGpsSurvey() {
    if (!isAdmin) return showToast('Silakan Login Admin untuk menyimpan hasil survei.', 'warning');
    stopGpsTrackRecording();

    const geomType = document.getElementById('gps-survey-geom-type')?.value || 'Polygon';
    const coords = gpsState.samples.map(s => [Number(s.lng.toFixed(6)), Number(s.lat.toFixed(6))]);

    if (geomType === 'Polygon' && coords.length < 3) {
        return showToast('Survei Poligon memerlukan minimal 3 titik koordinat.', 'warning');
    }
    if (geomType === 'LineString' && coords.length < 2) {
        return showToast('Survei Garis/Jalur memerlukan minimal 2 titik koordinat.', 'warning');
    }

    let geometry;
    if (geomType === 'Polygon') {
        const ring = [...coords];
        const first = ring[0];
        const last = ring[ring.length - 1];
        if (first[0] !== last[0] || first[1] !== last[1]) {
            ring.push([first[0], first[1]]);
        }
        geometry = { type: 'Polygon', coordinates: [ring] };
    } else {
        geometry = { type: 'LineString', coordinates: coords };
    }

    const avgAcc = gpsState.samples.reduce((acc, s) => acc + (s.accuracy || 0), 0) / gpsState.samples.length;
    const surveyFeature = {
        type: 'Feature',
        properties: {
            Source: 'GPS_Survey_Track',
            AccuracyMeters: Number(avgAcc.toFixed(1)),
            SampleCount: gpsState.samples.length
        },
        geometry: geometry
    };

    openFormForNewFeature(surveyFeature, `Survei Lapangan GPS (${gpsState.samples.length} titik)`, avgAcc);
}

// ==========================================
// 9. TOOLS GEOMETRI, PENCARIAN & PENGUKURAN
// ==========================================
function generateShape(type) {
    if (!isAdmin) {
        showToast('Silakan Login Admin terlebih dahulu untuk membuat geometri.', 'warning');
        modalLogin.show();
        return;
    }
    if (!map) return;

    const center = map.getCenter();
    let shapeFeature;
    if (type === 'circle') {
        shapeFeature = turf.circle([center.lng, center.lat], 0.2, { steps: 48, units: 'kilometers' });
    } else if (type === 'rectangle') {
        const pt = turf.point([center.lng, center.lat]);
        const buffered = turf.buffer(pt, 0.2, { units: 'kilometers' });
        shapeFeature = turf.bboxPolygon(turf.bbox(buffered));
    }

    if (shapeFeature) {
        shapeFeature.id = Date.now().toString();
        if (drawControl) {
            drawControl.deleteAll();
            drawControl.add(shapeFeature);
        }
        fiturSedangDigambar = shapeFeature;
        showToast(`Bentuk ${type === 'circle' ? 'Lingkaran' : 'Persegi Panjang'} dibuat. Silakan lengkapi atributnya.`, 'success');
        openFormForNewFeature(shapeFeature, `Generator ${type}`);
    }
}

function promptSearch() {
    document.getElementById('search-input').value = '';
    previewSearchResults();
    modalSearch.show();
}

function previewSearchResults() {
    const listEl = document.getElementById('search-results-list');
    if (!listEl) return;
    const q = (document.getElementById('search-input')?.value || '').trim();
    const { markers, shapes } = getMergedActiveData();
    const allItems = [...shapes, ...markers];

    // Cek apakah input berupa pasangan koordinat "lat, lng"
    const coordMatch = q.match(/^(-?\d+(?:\.\d+)?)\s*[,;\s]\s*(-?\d+(?:\.\d+)?)$/);
    if (coordMatch) {
        const lat = parseFloat(coordMatch[1]);
        const lng = parseFloat(coordMatch[2]);
        if (lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) {
            listEl.innerHTML = `
                <div class="p-2 rounded bg-primary bg-opacity-10 border border-primary border-opacity-25 d-flex justify-content-between align-items-center">
                    <span><i class="fa-solid fa-location-crosshairs text-primary me-2"></i>Koordinat: <b>${lat.toFixed(6)}, ${lng.toFixed(6)}</b></span>
                    <button type="button" class="btn btn-sm btn-primary" onclick="flyToSearchedCoordinate(${lat}, ${lng})">Buka Titik</button>
                </div>`;
            return;
        }
    }

    const matches = q
        ? allItems.filter(item =>
            String(item.Nama || '').toLowerCase().includes(q.toLowerCase()) ||
            String(item.Kategori || '').toLowerCase().includes(q.toLowerCase()) ||
            String(item.Deskripsi || '').toLowerCase().includes(q.toLowerCase())
        )
        : allItems.slice(0, 12);

    if (matches.length === 0) {
        listEl.innerHTML = '<div class="text-warning small">Tidak ditemukan objek yang cocok.</div>';
        return;
    }

    listEl.innerHTML = matches.map(item => `
        <div class="lokasi-item mb-1" onclick="selectSearchResultById('${escapeHtml(String(item.ID))}')">
            <div class="text-truncate">
                <strong>${escapeHtml(item.Nama || 'Tanpa Nama')}</strong>
                <div class="text-secondary" style="font-size:0.7rem;">${escapeHtml(item.Kategori || '-')}</div>
            </div>
            <i class="fa-solid fa-arrow-right text-primary small"></i>
        </div>
    `).join('');
}

function selectSearchResultById(id) {
    const { markers, shapes } = getMergedActiveData();
    const found = [...shapes, ...markers].find(x => String(x.ID) === String(id));
    if (found) {
        modalSearch.hide();
        sorotDanTampilkanDetail(found);
    }
}

function flyToSearchedCoordinate(lat, lng) {
    modalSearch.hide();
    if (map) {
        map.flyTo({ center: [lng, lat], zoom: 17.5, pitch: 0 });
        renderLiveGpsMarker(lng, lat);
    }
    showToast(`Menampilkan koordinat ${lat.toFixed(6)}, ${lng.toFixed(6)}`, 'info');
}

function executeSearch() {
    const q = (document.getElementById('search-input')?.value || '').trim();
    if (!q) return;

    const coordMatch = q.match(/^(-?\d+(?:\.\d+)?)\s*[,;\s]\s*(-?\d+(?:\.\d+)?)$/);
    if (coordMatch) {
        const lat = parseFloat(coordMatch[1]);
        const lng = parseFloat(coordMatch[2]);
        if (lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) {
            flyToSearchedCoordinate(lat, lng);
            return;
        }
    }

    const { markers, shapes } = getMergedActiveData();
    const hasil = [...shapes, ...markers].find(item =>
        (item.Nama && item.Nama.toLowerCase().includes(q.toLowerCase())) ||
        (item.Kategori && item.Kategori.toLowerCase().includes(q.toLowerCase()))
    );
    if (hasil) {
        modalSearch.hide();
        sorotDanTampilkanDetail(hasil);
        showToast(`Lokasi "${hasil.Nama}" ditemukan!`, 'success');
    } else {
        showToast('Objek tidak ditemukan dalam database.', 'warning');
    }
}

// Koordinat Kursor
let coordActive = false;
function toggleCoordinatePicker() {
    coordActive = !coordActive;
    const overlay = document.getElementById('coord-overlay');
    if (!overlay || !map) return;
    if (coordActive) {
        overlay.classList.remove('d-none');
        map.getCanvas().style.cursor = 'crosshair';
        map.on('mousemove', updateCoords);
    } else {
        overlay.classList.add('d-none');
        map.getCanvas().style.cursor = 'default';
        map.off('mousemove', updateCoords);
    }
}

function updateCoords(e) {
    document.getElementById('hover-lat').innerText = e.lngLat.lat.toFixed(6);
    document.getElementById('hover-lng').innerText = e.lngLat.lng.toFixed(6);
}

function copyCurrentCursorCoords() {
    const lat = document.getElementById('hover-lat')?.innerText || '';
    const lng = document.getElementById('hover-lng')?.innerText || '';
    if (!lat || lat === '-') return;
    const text = `${lat}, ${lng}`;
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(() => showToast(`Koordinat ${text} disalin!`, 'success'));
    } else {
        const ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
        showToast(`Koordinat ${text} disalin!`, 'success');
    }
}

// Pengukuran Jarak, Luas, dan Radius
function startMeasurement(type) {
    if (!drawControl) return showToast('Modul pengukuran belum siap.', 'danger');
    isMeasuring = true;
    measureType = type;
    drawControl.deleteAll();

    document.getElementById('measure-overlay').classList.remove('d-none');
    const labelMap = { distance: 'Jarak Lintasan', area: 'Luas Area', radius: 'Radius Jangkauan' };
    document.getElementById('measure-text').innerText = `Mode Ukur ${labelMap[type] || 'Jarak'}: Klik pada peta untuk mulai mengukur...`;

    drawControl.changeMode(type === 'area' ? 'draw_polygon' : 'draw_line_string');
}

function calculateMeasurement() {
    if (!isMeasuring || !drawControl) return;
    const data = drawControl.getAll();
    if (data.features.length > 0) {
        const feature = data.features[data.features.length - 1];
        if (measureType === 'distance' && feature.geometry.type === 'LineString') {
            const m = turf.length(feature, { units: 'kilometers' }) * 1000;
            document.getElementById('measure-text').innerText = m >= 1000
                ? `Jarak: ${m.toFixed(1)} Meter (${(m / 1000).toFixed(3)} km)`
                : `Jarak: ${m.toFixed(2)} Meter`;
        } else if (measureType === 'area' && feature.geometry.type === 'Polygon') {
            const m2 = turf.area(feature);
            const ha = m2 / 10000;
            document.getElementById('measure-text').innerText = `Luas: ${m2.toLocaleString('id-ID', { maximumFractionDigits: 2 })} m² (${ha.toFixed(3)} Ha)`;
        } else if (measureType === 'radius' && feature.geometry.type === 'LineString' && feature.geometry.coordinates.length >= 2) {
            const coords = feature.geometry.coordinates;
            const center = coords[0];
            const edge = coords[coords.length - 1];
            const radiusKm = turf.distance(turf.point(center), turf.point(edge), { units: 'kilometers' });
            const radiusM = radiusKm * 1000;
            const circleAreaM2 = Math.PI * radiusM * radiusM;
            document.getElementById('measure-text').innerText = `Radius: ${radiusM.toFixed(1)} m | Luas Lingkaran: ${(circleAreaM2 / 10000).toFixed(2)} Ha`;
        }
    }
}

function stopMeasurement() {
    isMeasuring = false;
    document.getElementById('measure-overlay').classList.add('d-none');
    if (drawControl) drawControl.deleteAll();
}

// ==========================================
// 10. IMPOR & EKSPOR GEOJSON STANDAR
// ==========================================
function openGeoJSONModal() {
    document.getElementById('geojson-text-area').value = '';
    const fileIn = document.getElementById('geojson-file-input');
    if (fileIn) fileIn.value = '';
    modalGeoJSON.show();
}

function handleGeoJSONFileSelect(event) {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
        document.getElementById('geojson-text-area').value = e.target.result || '';
    };
    reader.readAsText(file);
}

function exportAllDataAsGeoJSON() {
    const { markers, shapes } = getMergedActiveData();
    const features = [];

    markers.forEach(m => {
        const lat = parseFloat(m.Lat);
        const lng = parseFloat(m.Lng);
        if (!isFinite(lat) || !isFinite(lng)) return;
        features.push({
            type: 'Feature',
            properties: { ...m, geometryKind: 'Marker' },
            geometry: { type: 'Point', coordinates: [lng, lat] }
        });
    });

    shapes.forEach(s => {
        if (!s.GeoJSON) return;
        try {
            const geom = typeof s.GeoJSON === 'string' ? JSON.parse(s.GeoJSON) : s.GeoJSON;
            const props = { ...s };
            delete props.GeoJSON;
            features.push({
                type: 'Feature',
                properties: props,
                geometry: geom
            });
        } catch (e) {
            // Lewati jika rusak
        }
    });

    const fc = {
        type: 'FeatureCollection',
        metadata: {
            portal: 'Portal GIS Terpadu',
            exportedAt: new Date().toISOString(),
            totalFeatures: features.length
        },
        features: features
    };

    const blob = new Blob([JSON.stringify(fc, null, 2)], { type: 'application/geo+json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Portal_GIS_Data_${new Date().toISOString().slice(0, 10)}.geojson`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    showToast(`Berhasil mengekspor ${features.length} objek ke file GeoJSON.`, 'success');
}

function importGeoJSONFromModal() {
    if (!isAdmin) {
        showToast('Silakan Login Admin untuk mengimpor GeoJSON ke Draft.', 'warning');
        return;
    }
    const raw = (document.getElementById('geojson-text-area')?.value || '').trim();
    if (!raw) return showToast('Pilih file atau tempelkan struktur GeoJSON terlebih dahulu.', 'warning');

    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (e) {
        return showToast('Format JSON tidak valid: ' + e.message, 'danger');
    }

    const features = parsed.type === 'FeatureCollection'
        ? (parsed.features || [])
        : (parsed.type === 'Feature' ? [parsed] : []);

    if (features.length === 0) {
        return showToast('Tidak ditemukan fitur geometri yang valid di dalam GeoJSON.', 'warning');
    }

    pushUndoSnapshot();
    let importedCount = 0;
    const nowIso = new Date().toISOString();

    features.forEach((f, idx) => {
        if (!f || !f.geometry || !f.geometry.type || !Array.isArray(f.geometry.coordinates)) return;
        const p = f.properties || {};
        const id = String(p.ID || p.id || `imp_${Date.now()}_${idx}`);
        const nama = String(p.Nama || p.name || p.NAME_3 || `Objek Impor #${idx + 1}`);
        const kategori = String(p.Kategori || p.category || p.TYPE_3 || 'Hasil Impor GeoJSON');
        const deskripsi = String(p.Deskripsi || p.description || '');
        const defColors = getDefaultColorByCategory(kategori);

        if (f.geometry.type === 'Point') {
            const [lng, lat] = f.geometry.coordinates;
            if (!isFinite(lat) || !isFinite(lng)) return;
            upsertItemIntoDraft({
                ID: id,
                Nama: nama,
                Kategori: kategori,
                Deskripsi: deskripsi,
                Icon: p.Icon || 'fa-location-dot',
                Lat: Number(lat.toFixed(6)),
                Lng: Number(lng.toFixed(6)),
                Warna: p.Warna || defColors.fill,
                UkuranMarker: p.UkuranMarker || 34,
                Status: 'Active',
                Timestamp: nowIso,
                CreatedAt: nowIso,
                Source: 'GeoJSON_Import'
            }, true);
            importedCount++;
        } else {
            const metrics = computeGeometryMetrics(f.geometry);
            upsertItemIntoDraft({
                ID: id,
                Nama: nama,
                Kategori: kategori,
                Deskripsi: deskripsi,
                WarnaArea: p.WarnaArea || defColors.fill,
                WarnaGaris: p.WarnaGaris || defColors.stroke,
                Opacity: p.Opacity !== undefined ? p.Opacity : 0.35,
                KetebalanGaris: p.KetebalanGaris || 2.5,
                GeoJSON: JSON.stringify(f.geometry),
                GeometryType: f.geometry.type,
                LuasM2: metrics.areaM2,
                PanjangM: metrics.lengthM,
                Status: 'Active',
                Timestamp: nowIso,
                CreatedAt: nowIso,
                Source: 'GeoJSON_Import'
            }, false);
            importedCount++;
        }
    });

    modalGeoJSON.hide();
    populateCategoryOptions();
    renderMenuKategori();
    renderObjekKePeta();
    showToast(`Berhasil mengimpor ${importedCount} objek GeoJSON ke dalam Draft.`, 'success');
}

// ==========================================
// 11. EKSPOR KARTOGRAFIS JPG / PNG & PDF PROFESIONAL
// ==========================================
function openExportModal(defaultFormat = 'pdf') {
    const fmtSelect = document.getElementById('export-format');
    if (fmtSelect && defaultFormat) fmtSelect.value = defaultFormat;
    const statusEl = document.getElementById('export-progress-status');
    if (statusEl) statusEl.innerText = '';
    modalExport.show();
}

// Kompatibilitas dengan pemanggilan fungsi lama
function exportKeJPG() {
    openExportModal('jpg');
}

function exportKePDF() {
    openExportModal('pdf');
}

function getFilteredObjectsForExport() {
    const scope = document.getElementById('export-filter-scope')?.value || 'all';
    const { markers, shapes } = getMergedActiveData();

    if (scope === 'selected' && objekTerpilihSaatIni) {
        const isMarker = objekTerpilihSaatIni.Lat !== undefined && objekTerpilihSaatIni.Lat !== '';
        return {
            markers: isMarker ? [objekTerpilihSaatIni] : [],
            shapes: isMarker ? [] : [objekTerpilihSaatIni]
        };
    }

    if (scope === 'category') {
        const targetCat = document.getElementById('export-category-select')?.value || '';
        return {
            markers: markers.filter(m => m.Kategori === targetCat),
            shapes: shapes.filter(s => s.Kategori === targetCat)
        };
    }

    return { markers, shapes };
}

function computeMapScaleInfo() {
    if (!map) {
        return { ratioText: '1 : 25.000 (Estimasi)', barMeters: 500, barLabel: '500 m', barPixelWidth: 110, valid: true };
    }
    try {
        const center = map.getCenter();
        const zoom = map.getZoom();
        // Resolusi meter per piksel pada garis lintang saat ini
        const metersPerPixel = (156543.03392 * Math.cos((center.lat * Math.PI) / 180)) / Math.pow(2, zoom);
        const targetPx = 100;
        const rawMeters = metersPerPixel * targetPx;

        // Bulatkan ke angka skala kartografis yang rapi
        const niceSteps = [10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 25000, 50000];
        let barMeters = niceSteps[0];
        for (const step of niceSteps) {
            if (rawMeters >= step * 0.65) barMeters = step;
        }
        const barPixelWidth = Math.round(barMeters / metersPerPixel);
        const barLabel = barMeters >= 1000 ? `${barMeters / 1000} km` : `${barMeters} m`;
        const approxRatio = Math.round((metersPerPixel * 96) / 0.0254);

        return {
            ratioText: `1 : ${approxRatio.toLocaleString('id-ID')}`,
            barMeters,
            barLabel,
            barPixelWidth: Math.min(180, Math.max(60, barPixelWidth)),
            valid: true
        };
    } catch (e) {
        return { ratioText: 'Skala Dinamis', barMeters: 0, barLabel: 'N/A', barPixelWidth: 100, valid: false };
    }
}

function getMapBoundsInfo() {
    if (!map) {
        return { text: '121.6400°BT - 121.6850°BT | -8.8200°LS - -8.8600°LS', valid: true };
    }
    try {
        const b = map.getBounds();
        const sw = b.getSouthWest();
        const ne = b.getNorthEast();
        return {
            text: `Batas Koordinat: [${sw.lat.toFixed(4)}°, ${sw.lng.toFixed(4)}°] s/d [${ne.lat.toFixed(4)}°, ${ne.lng.toFixed(4)}°]`,
            sw,
            ne,
            valid: true
        };
    } catch (e) {
        return { text: 'Batas Koordinat: Sesuai Tampilan Aktif', valid: false };
    }
}

/**
 * Merender Kanvas Kartografis Lengkap (Peta + Marker + Poligon + Header + Arah Utara + Skala + Legenda + Extent)
 */
async function buildCartographicCanvas(options) {
    const scaleFactor = parseFloat(options.resolution || '1.5');
    const isPortrait = options.orientation === 'portrait';
    const baseW = isPortrait ? 900 : 1280;
    const baseH = isPortrait ? 1200 : 820;

    const canvas = document.createElement('canvas');
    canvas.width = Math.round(baseW * scaleFactor);
    canvas.height = Math.round(baseH * scaleFactor);
    const ctx = canvas.getContext('2d');
    ctx.scale(scaleFactor, scaleFactor);

    // 1. Latar Belakang Bingkai Kartografis
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 0, baseW, baseH);

    const headerH = 82;
    const footerH = 44;
    const mapX = 18;
    const mapY = headerH + 8;
    const mapW = baseW - 36;
    const mapH = baseH - headerH - footerH - 16;

    // 2. Header Judul & Identitas Peta
    ctx.fillStyle = '#1e293b';
    ctx.fillRect(18, 12, baseW - 36, headerH - 8);
    ctx.strokeStyle = '#334155';
    ctx.lineWidth = 1;
    ctx.strokeRect(18, 12, baseW - 36, headerH - 8);

    ctx.fillStyle = '#38bdf8';
    ctx.font = 'bold 20px "Segoe UI", sans-serif';
    ctx.fillText(options.title || 'PETA INFORMASI GEOGRAFIS TATA RUANG WILAYAH', 32, 40);

    ctx.fillStyle = '#e2e8f0';
    ctx.font = '13px "Segoe UI", sans-serif';
    ctx.fillText(`${options.subtitle || 'Kabupaten Ende'} — ${options.agency || 'Portal GIS Terpadu'}`, 32, 62);

    const exportDateStr = new Date().toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' });
    ctx.fillStyle = '#94a3b8';
    ctx.font = '11px "Segoe UI", sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(`Diekspor: ${exportDateStr}`, baseW - 32, 38);
    ctx.fillText(`Basemap: ${currentBasemapMode.toUpperCase()}`, baseW - 32, 58);
    ctx.textAlign = 'left';

    // 3. Area Kanvas Peta Utama
    ctx.save();
    ctx.beginPath();
    ctx.rect(mapX, mapY, mapW, mapH);
    ctx.clip();

    ctx.fillStyle = '#182232';
    ctx.fillRect(mapX, mapY, mapW, mapH);

    // Ambil snapshot dari Mapbox WebGL canvas bila tersedia
    let mapSnapshotDrawn = false;
    if (map && map.getCanvas()) {
        try {
            const glCanvas = map.getCanvas();
            const dataUrl = glCanvas.toDataURL('image/png');
            if (dataUrl && dataUrl.length > 200) {
                const img = await loadImageAsync(dataUrl);
                ctx.drawImage(img, mapX, mapY, mapW, mapH);
                mapSnapshotDrawn = true;
            }
        } catch (e) {
            console.warn('Fallback vector map composer digunakan:', e);
        }
    }

    // Proyeksi pembantu untuk menggambar vektor / marker / label di atas kanvas ekspor
    const { markers, shapes } = options.filteredData;
    const projectPoint = (lng, lat) => {
        if (map) {
            try {
                const containerRect = map.getContainer().getBoundingClientRect();
                const pt = map.project([lng, lat]);
                const relX = pt.x / (containerRect.width || mapW);
                const relY = pt.y / (containerRect.height || mapH);
                return { x: mapX + relX * mapW, y: mapY + relY * mapH };
            } catch (e) {
                // Fallback linear
            }
        }
        const x = mapX + ((lng - 121.55) / 0.35) * mapW;
        const y = mapY + ((-8.70 - lat) / 0.25) * mapH;
        return { x, y };
    };

    // Jika WebGL tidak ter-capture (mis. mode sandbox tanpa GPU), gambar grid & poligon vektor secara eksplisit
    if (!mapSnapshotDrawn) {
        ctx.strokeStyle = 'rgba(148, 163, 184, 0.12)';
        ctx.lineWidth = 1;
        for (let gx = mapX; gx < mapX + mapW; gx += 60) {
            ctx.beginPath(); ctx.moveTo(gx, mapY); ctx.lineTo(gx, mapY + mapH); ctx.stroke();
        }
        for (let gy = mapY; gy < mapY + mapH; gy += 60) {
            ctx.beginPath(); ctx.moveTo(mapX, gy); ctx.lineTo(mapX + mapW, gy); ctx.stroke();
        }

        shapes.forEach(s => {
            if (!s.GeoJSON) return;
            try {
                const geom = typeof s.GeoJSON === 'string' ? JSON.parse(s.GeoJSON) : s.GeoJSON;
                const fillHex = s.WarnaArea || '#0d6efd';
                const strokeHex = s.WarnaGaris || '#6ea8fe';
                const op = clampVal(s.Opacity, 0.1, 0.9, 0.35);

                if (geom.type === 'Polygon' && geom.coordinates[0]) {
                    ctx.beginPath();
                    geom.coordinates[0].forEach((coord, i) => {
                        const p = projectPoint(coord[0], coord[1]);
                        if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
                    });
                    ctx.closePath();
                    ctx.fillStyle = hexToRgba(fillHex, op);
                    ctx.fill();
                    ctx.strokeStyle = strokeHex;
                    ctx.lineWidth = s.KetebalanGaris || 2;
                    ctx.stroke();
                } else if (geom.type === 'LineString' && geom.coordinates) {
                    ctx.beginPath();
                    geom.coordinates.forEach((coord, i) => {
                        const p = projectPoint(coord[0], coord[1]);
                        if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
                    });
                    ctx.strokeStyle = strokeHex;
                    ctx.lineWidth = s.KetebalanGaris || 2.5;
                    ctx.stroke();
                }
            } catch (e) {}
        });
    }

    // 4. Gambar DOM Markers & Label Objek ke Kanvas Ekspor (karena DOM marker berada di luar WebGL canvas)
    markers.forEach(m => {
        const lat = parseFloat(m.Lat);
        const lng = parseFloat(m.Lng);
        if (!isFinite(lat) || !isFinite(lng)) return;
        const pt = projectPoint(lng, lat);
        if (pt.x < mapX || pt.x > mapX + mapW || pt.y < mapY || pt.y > mapY + mapH) return;

        const mColor = m.Warna || m.WarnaArea || getDefaultColorByCategory(m.Kategori).fill;
        const r = Math.round(clampVal(m.UkuranMarker, 24, 54, 34) / 2);

        ctx.beginPath();
        ctx.arc(pt.x, pt.y, r, 0, Math.PI * 2);
        ctx.fillStyle = '#1e293b';
        ctx.fill();
        ctx.lineWidth = 3;
        ctx.strokeStyle = mColor;
        ctx.stroke();

        ctx.beginPath();
        ctx.arc(pt.x, pt.y, 4, 0, Math.PI * 2);
        ctx.fillStyle = mColor;
        ctx.fill();

        if (options.includeLabels && m.Nama) {
            ctx.font = 'bold 11px "Segoe UI", sans-serif';
            ctx.textAlign = 'center';
            ctx.strokeStyle = '#0f172a';
            ctx.lineWidth = 3;
            const lbl = truncateLabel(m.Nama, 24);
            ctx.strokeText(lbl, pt.x, pt.y + r + 13);
            ctx.fillStyle = '#f8fafc';
            ctx.fillText(lbl, pt.x, pt.y + r + 13);
            ctx.textAlign = 'left';
        }
    });

    // 5. Komponen Arah Utara (North Arrow) & Skala Peta
    if (options.includeScale) {
        const compassX = mapX + mapW - 46;
        const compassY = mapY + 46;
        ctx.fillStyle = 'rgba(15, 23, 42, 0.85)';
        ctx.beginPath();
        ctx.arc(compassX, compassY, 28, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#64748b';
        ctx.lineWidth = 1.5;
        ctx.stroke();

        // Jarum Utara
        ctx.beginPath();
        ctx.moveTo(compassX, compassY - 18);
        ctx.lineTo(compassX - 7, compassY + 8);
        ctx.lineTo(compassX, compassY + 3);
        ctx.lineTo(compassX + 7, compassY + 8);
        ctx.closePath();
        ctx.fillStyle = '#ef4444';
        ctx.fill();

        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 10px "Segoe UI", sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('U', compassX, compassY - 19);
        ctx.textAlign = 'left';

        // Kotak Skala Peta
        const scaleInfo = computeMapScaleInfo();
        const sbX = mapX + 16;
        const sbY = mapY + mapH - 54;
        const sbW = scaleInfo.barPixelWidth + 36;
        ctx.fillStyle = 'rgba(15, 23, 42, 0.86)';
        ctx.fillRect(sbX, sbY, sbW, 40);
        ctx.strokeStyle = '#475569';
        ctx.strokeRect(sbX, sbY, sbW, 40);

        ctx.fillStyle = '#f8fafc';
        ctx.font = 'bold 10px "Segoe UI", sans-serif';
        ctx.fillText(`Skala ${scaleInfo.ratioText} (${scaleInfo.barLabel})`, sbX + 10, sbY + 15);

        // Batang skala hitam-putih
        const barStartX = sbX + 10;
        const barStartY = sbY + 23;
        const halfW = Math.round(scaleInfo.barPixelWidth / 2);
        ctx.fillStyle = '#38bdf8';
        ctx.fillRect(barStartX, barStartY, halfW, 7);
        ctx.fillStyle = '#e2e8f0';
        ctx.fillRect(barStartX + halfW, barStartY, halfW, 7);
    }

    // 6. Kotak Legenda Dinamis di Sudut Kanan Bawah Peta
    if (options.includeLegend) {
        const legendItems = [];
        const seenCats = new Set();
        [...shapes, ...markers].forEach(item => {
            const kat = item.Kategori || 'Lainnya';
            if (!seenCats.has(kat) && legendItems.length < 8) {
                seenCats.add(kat);
                legendItems.push({
                    label: kat,
                    color: item.Warna || item.WarnaArea || getDefaultColorByCategory(kat).fill
                });
            }
        });

        if (legendItems.length > 0) {
            const legW = 220;
            const legH = 32 + legendItems.length * 18;
            const legX = mapX + mapW - legW - 16;
            const legY = mapY + mapH - legH - 14;

            ctx.fillStyle = 'rgba(15, 23, 42, 0.88)';
            ctx.fillRect(legX, legY, legW, legH);
            ctx.strokeStyle = '#475569';
            ctx.strokeRect(legX, legY, legW, legH);

            ctx.fillStyle = '#38bdf8';
            ctx.font = 'bold 11px "Segoe UI", sans-serif';
            ctx.fillText('LEGENDA KATEGORI', legX + 12, legY + 18);

            legendItems.forEach((li, idx) => {
                const rowY = legY + 34 + idx * 18;
                ctx.fillStyle = li.color;
                ctx.fillRect(legX + 12, rowY - 9, 12, 12);
                ctx.fillStyle = '#f1f5f9';
                ctx.font = '11px "Segoe UI", sans-serif';
                ctx.fillText(truncateLabel(li.label, 25), legX + 30, rowY);
            });
        }
    }

    ctx.restore();

    // Bingkai luar area peta
    ctx.strokeStyle = '#475569';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(mapX, mapY, mapW, mapH);

    // 7. Footer Metadata, Sumber Data & Extent Koordinat
    const boundsInfo = getMapBoundsInfo();
    ctx.fillStyle = '#cbd5e1';
    ctx.font = '11px "Segoe UI", sans-serif';
    ctx.fillText(options.author || 'Sumber: Database Spreadsheet Portal GIS Terpadu', 24, baseH - 18);

    if (options.includeExtent) {
        ctx.textAlign = 'right';
        ctx.fillStyle = '#94a3b8';
        ctx.fillText(boundsInfo.text, baseW - 24, baseH - 18);
        ctx.textAlign = 'left';
    }

    return canvas;
}

function loadImageAsync(src) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => resolve(img);
        img.onerror = (e) => reject(e);
        img.src = src;
    });
}

async function executeCartographicExport() {
    const btn = document.getElementById('btn-run-export');
    const statusEl = document.getElementById('export-progress-status');

    const options = {
        title: document.getElementById('export-title')?.value || 'PETA INFORMASI GEOGRAFIS TATA RUANG WILAYAH',
        subtitle: document.getElementById('export-subtitle')?.value || 'Kabupaten Ende - Provinsi Nusa Tenggara Timur',
        agency: document.getElementById('export-agency')?.value || 'Portal GIS Terpadu',
        author: document.getElementById('export-author')?.value || 'Sumber: Database Spreadsheet GIS',
        format: document.getElementById('export-format')?.value || 'pdf',
        orientation: document.getElementById('export-orientation')?.value || 'landscape',
        resolution: document.getElementById('export-resolution')?.value || '1.5',
        includeLegend: document.getElementById('exp-inc-legend')?.checked ?? true,
        includeScale: document.getElementById('exp-inc-scale')?.checked ?? true,
        includeExtent: document.getElementById('exp-inc-extent')?.checked ?? true,
        includeLabels: document.getElementById('exp-inc-labels')?.checked ?? true,
        filteredData: getFilteredObjectsForExport()
    };

    if (btn) btn.disabled = true;
    if (statusEl) statusEl.innerHTML = '<i class="fa-solid fa-spinner fa-spin me-1"></i>Menyusun komposisi peta kartografis...';

    try {
        const canvas = await buildCartographicCanvas(options);
        const dateStamp = new Date().toISOString().slice(0, 10);

        if (options.format === 'jpg' || options.format === 'png') {
            const mime = options.format === 'png' ? 'image/png' : 'image/jpeg';
            const dataUrl = canvas.toDataURL(mime, 0.94);
            const link = document.createElement('a');
            link.download = `Peta_GIS_${dateStamp}.${options.format}`;
            link.href = dataUrl;
            link.click();
            modalExport.hide();
            showToast(`Peta berhasil diekspor ke format ${options.format.toUpperCase()}.`, 'success');
        } else {
            // Ekspor Dokumen PDF Profesional (Halaman 1: Peta + Ringkasan, Halaman 2+: Tabel Daftar Objek)
            if (statusEl) statusEl.innerHTML = '<i class="fa-solid fa-spinner fa-spin me-1"></i>Menyusun laporan PDF multi-halaman...';
            const mapImageDataUrl = canvas.toDataURL('image/jpeg', 0.92);
            const { markers, shapes } = options.filteredData;
            const allRows = [...shapes, ...markers];
            const scaleInfo = computeMapScaleInfo();
            const boundsInfo = getMapBoundsInfo();

            const tableBody = [
                [
                    { text: 'No', bold: true, fillColor: '#1e293b', color: '#ffffff', fontSize: 9 },
                    { text: 'Nama Objek', bold: true, fillColor: '#1e293b', color: '#ffffff', fontSize: 9 },
                    { text: 'Kategori', bold: true, fillColor: '#1e293b', color: '#ffffff', fontSize: 9 },
                    { text: 'Jenis Geometri', bold: true, fillColor: '#1e293b', color: '#ffffff', fontSize: 9 },
                    { text: 'Koordinat (Lat, Lng)', bold: true, fillColor: '#1e293b', color: '#ffffff', fontSize: 9 },
                    { text: 'Luas / Panjang Valid', bold: true, fillColor: '#1e293b', color: '#ffffff', fontSize: 9 },
                    { text: 'Status Data', bold: true, fillColor: '#1e293b', color: '#ffffff', fontSize: 9 }
                ]
            ];

            allRows.forEach((item, idx) => {
                const isMarker = item.Lat !== undefined && item.Lat !== '';
                let coordStr = '-';
                let metricStr = '-';
                let geomLabel = 'Titik (Point)';

                if (isMarker) {
                    coordStr = `${Number(item.Lat).toFixed(5)}, ${Number(item.Lng).toFixed(5)}`;
                    metricStr = item.AccuracyMeters ? `Akurasi \u00B1${item.AccuracyMeters}m` : 'Titik Lokasi';
                } else if (item.GeoJSON) {
                    try {
                        const g = typeof item.GeoJSON === 'string' ? JSON.parse(item.GeoJSON) : item.GeoJSON;
                        geomLabel = g.type || 'Polygon';
                        const c = turf.centroid({ type: 'Feature', properties: {}, geometry: g });
                        coordStr = `${c.geometry.coordinates[1].toFixed(5)}, ${c.geometry.coordinates[0].toFixed(5)}`;
                        const m = computeGeometryMetrics(g);
                        if (geomLabel.includes('Polygon')) {
                            metricStr = `${m.areaM2.toLocaleString('id-ID')} m\u00B2`;
                        } else if (geomLabel.includes('Line')) {
                            metricStr = `${m.lengthM.toLocaleString('id-ID')} m`;
                        }
                    } catch (e) {
                        geomLabel = 'Geometri';
                    }
                }

                const syncLabel = item.isDraft ? 'Draft Lokal' : 'Tersinkronisasi';
                tableBody.push([
                    { text: String(idx + 1), fontSize: 8.5 },
                    { text: String(item.Nama || 'Tanpa Nama'), fontSize: 8.5, bold: true },
                    { text: String(item.Kategori || '-'), fontSize: 8.5 },
                    { text: geomLabel, fontSize: 8.5 },
                    { text: coordStr, fontSize: 8 },
                    { text: metricStr, fontSize: 8.5 },
                    { text: syncLabel, fontSize: 8, color: item.isDraft ? '#b45309' : '#15803d' }
                ]);
            });

            const docDefinition = {
                pageSize: 'A4',
                pageOrientation: options.orientation,
                pageMargins: [30, 30, 30, 35],
                content: [
                    { text: options.agency.toUpperCase(), fontSize: 10, bold: true, color: '#0d6efd', alignment: 'center' },
                    { text: options.title, fontSize: 16, bold: true, alignment: 'center', margin: [0, 2, 0, 2] },
                    { text: options.subtitle, fontSize: 11, italics: true, color: '#475569', alignment: 'center', margin: [0, 0, 0, 10] },
                    {
                        image: mapImageDataUrl,
                        width: options.orientation === 'landscape' ? 760 : 520,
                        alignment: 'center',
                        margin: [0, 0, 0, 10]
                    },
                    {
                        columns: [
                            { text: `Ringkasan Objek: ${allRows.length} Total (${markers.length} Titik Lokasi, ${shapes.length} Area/Jalur)`, fontSize: 9, bold: true },
                            { text: `Estimasi Skala: ${scaleInfo.ratioText} | ${boundsInfo.text}`, fontSize: 8.5, alignment: 'right', color: '#475569' }
                        ],
                        margin: [0, 2, 0, 4]
                    },
                    { text: options.author, fontSize: 8.5, color: '#64748b', margin: [0, 0, 0, 10] },
                    { text: 'DAFTAR INVENTARIS OBJEK GEOGRAFIS TERDAFTAR', fontSize: 12, bold: true, pageBreak: allRows.length > 6 ? 'before' : undefined, margin: [0, 5, 0, 8] },
                    allRows.length > 0 ? {
                        table: {
                            headerRows: 1,
                            widths: [22, '*', 'auto', 'auto', 'auto', 'auto', 'auto'],
                            body: tableBody
                        },
                        layout: 'lightHorizontalLines'
                    } : { text: 'Tidak ada objek pada cakupan filter yang dipilih.', italics: true, fontSize: 10 }
                ],
                footer: function(currentPage, pageCount) {
                    return {
                        columns: [
                            { text: `${options.agency} — Dicetak: ${new Date().toLocaleString('id-ID')}`, fontSize: 8, color: '#64748b', margin: [30, 10, 0, 0] },
                            { text: `Halaman ${currentPage} dari ${pageCount}`, alignment: 'right', fontSize: 8, color: '#64748b', margin: [0, 10, 30, 0] }
                        ]
                    };
                }
            };

            pdfMake.createPdf(docDefinition).download(`Laporan_GIS_Wilayah_${dateStamp}.pdf`);
            modalExport.hide();
            showToast('Laporan PDF kartografis berhasil dibuat dan diunduh.', 'success');
        }
    } catch (err) {
        console.error('Export error:', err);
        showToast('Gagal membuat file ekspor: ' + (err.message || String(err)), 'danger');
    } finally {
        if (btn) btn.disabled = false;
        if (statusEl) statusEl.innerText = '';
    }
}

// ==========================================
// 12. FUNGSI HELPER UMUM
// ==========================================
function clampVal(val, min, max, fallback) {
    const n = Number(val);
    if (!isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
}

function truncateLabel(str, maxLen = 26) {
    const s = String(str || '').trim();
    return s.length > maxLen ? s.substring(0, maxLen - 1) + '…' : s;
}

function escapeHtml(str) {
    return String(str === undefined || str === null ? '' : str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
