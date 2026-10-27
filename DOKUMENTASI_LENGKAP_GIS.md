# Dokumentasi Teknis & Panduan Lengkap — Portal GIS Terpadu (v2.1)

Dokumen ini memuat hasil audit menyeluruh terhadap source code asli (`gis_stpm-main`), daftar bug beserta perbaikannya, spesifikasi skema Google Spreadsheet, panduan deployment Google Apps Script (`Code.gs`), panduan konfigurasi API & Mapbox, petunjuk penggunaan GPS & survei lapangan, panduan tools GIS, dokumentasi ekspor kartografis JPG/PNG/PDF, serta laporan pengujian.

## 1. Hasil Audit Kode Awal & Daftar Perbaikan Bug

Sebelum melakukan pengembangan, seluruh file asli (`index.html`, `style.css`, `script.js`, dan `gadm41_ende.json`) telah diperiksa secara menyeluruh. Tabel berikut merangkum temuan berdasarkan tingkat prioritas beserta perbaikan yang telah diimplementasikan.

| ID Temuan | Prioritas | Lokasi Kode Asli | Deskripsi Masalah / Bug pada Kode Asli | Perbaikan yang Diimplementasikan |
| :--- | :--- | :--- | :--- | :--- |
| **BUG-01** | **Kritis** | `script.js` baris 492–504 (`kirimDraftKeServer`) | Blok `try` tidak memeriksa status HTTP maupun isi JSON respons (`status === 'success'`). Lebih fatal lagi, blok `catch(e)` justru menampilkan toast hijau `"Proses selesai! Layar akan dimuat ulang."` lalu memanggil `location.reload()`, sehingga saat internet terputus atau API gagal, seluruh draft pengguna hilang permanen. | Dihapusnya `location.reload()` paksa; fungsi `performServerSync()` kini memvalidasi `respon.ok`, mengurai JSON, dan memastikan `status === 'success'`. Jika gagal, antrean draft tetap tersimpan aman di `localStorage`, indikator status berubah menjadi **Gagal Sinkron**, dan tombol **Coba Lagi** muncul dengan mekanisme *exponential backoff*. |
| **BUG-02** | **Kritis** | `script.js` baris 353–365 (`renderObjekKePeta`) & 456–490 (`simpanKeDraftMemori`) | `renderObjekKePeta()` membuang seluruh atribut properti objek dan memaksa seluruh poligon/garis berwarna `#0d6efd` dengan opacity `0.3`. Selain itu, `simpanKeDraftMemori()` tidak pernah menyimpan `WarnaArea`, `WarnaGaris`, `Opacity`, `KetebalanGaris`, `Warna`, atau `UkuranMarker`. | Ditambahkan data-driven styling Mapbox (`['get', 'fillColor']`, `['get', 'fillOpacity']`, `['get', 'lineColor']`, `['get', 'lineWidth']`), pemisahan layer `fill-poligon`, `garis-poligon`, dan `garis-jalur` (`LineString`), serta penyimpanan seluruh atribut warna, opacity, ukuran marker, dan ketebalan garis ke Draft & Spreadsheet. |
| **BUG-03** | **Kritis** | `script.js` baris 509–515 (`generateShape`) | Pembuatan Persegi Panjang (`rectangle`) dan Lingkaran (`circle`) hanya memanggil `drawControl.add(shape)` tanpa mengisi `fiturSedangDigambar` dan tanpa membuka modal formulir atribut, sehingga bentuk yang dibuat tidak pernah bisa disimpan ke Draft. | `generateShape()` kini langsung mengikat geometri hasil Turf.js ke `fiturSedangDigambar` dan memanggil `openFormForNewFeature()` agar pengguna dapat mengisi nama, kategori, warna, dan menyimpannya ke Draft. |
| **BUG-04** | **Kritis** | `script.js` baris 416–435 (`prosesEditObjek`) | Saat mengedit objek yang sudah ada, geometri dikunci (`"Data Geometri Terkunci (Hanya Edit Metadata)"`) sehingga pengguna tidak dapat mengedit titik sudut poligon/garis maupun memindahkan posisi marker. | Ditambahkan fitur **Edit Geometri** (`direct_select` pada Mapbox Draw untuk menggeser vertex poligon/garis) dan **Pindahkan Objek** (marker *draggable* / geser titik), serta pengeditan koordinat Lat/Lng langsung di modal tanpa menghilangkan atribut asli. |
| **BUG-05** | **Tinggi** | `script.js` baris 274–301 (`renderMenuKategori`), 528 (`executeSearch`), & 579 (`exportKePDF`) | Objek yang telah dihapus dengan *Soft Delete* (`Status: 'Deleted'`) hanya difilter di `renderObjekKePeta()`, tetapi masih muncul di daftar navigasi sidebar kiri, hasil pencarian, dan tabel laporan PDF. | Dibuat fungsi terpusat `getMergedActiveData()` yang menggabungkan `databaseUtama` dan `draftSession` berdasarkan `ID` unik serta menyaring seluruh objek berstatus `Deleted` dari sidebar, pencarian, peta, dan laporan ekspor. |
| **BUG-06** | **Tinggi** | `script.js` baris 366–372 & 520 (`locateUser`) | Pembuatan marker menggunakan `document.querySelectorAll('.custom-marker').forEach(m => m.remove())` tanpa memanggil `.remove()` pada instance `mapboxgl.Marker`, menyebabkan kebocoran memori (*memory leak*). Selain itu, klik berulang pada `Lokasi Saya` menumpuk marker merah tanpa menghapus marker sebelumnya. | Seluruh instance `mapboxgl.Marker` dikelola dalam array `activeMapMarkers` dan dibersihkan dengan `marker.remove()` sebelum render ulang. Marker GPS dikelola secara tunggal melalui `tempGpsMarker`. |
| **BUG-07** | **Tinggi** | `script.js` baris 438–472 (`prosesHapusObjek` & `simpanKeDraftMemori`) | Menghapus atau mengedit objek yang baru ada di `draftSession` menambahkan objek duplikat ke `draftSession` tanpa memperbarui entri yang sudah ada. | Dibuat fungsi `upsertItemIntoDraft(obj, isMarker)` yang memeriksa keberadaan `ID` di `draftSession` agar pembaruan atau penghapusan draft selalu bersifat *idempotent* (bebas duplikasi). |
| **BUG-08** | **Tinggi** | `script.js` baris 569–590 (`exportKePDF` & `exportKeJPG`) | Ekspor mengandalkan `html2canvas(document.getElementById('map-container'))` yang sering gagal menangkap layer WebGL atau memotong kontrol antarmuka, tidak memiliki arah utara, skala peta, koordinat batas (*extent*), maupun filter objek, dan memalsukan status tabel PDF menjadi `'Tersinkronisasi'` untuk semua baris. | Dibangun mesin **Cartographic Canvas Composer** (`buildCartographicCanvas`) yang menggabungkan kanvas WebGL (`preserveDrawingBuffer: true`), vektor/marker kustom, label geografis, header judul, kompas arah utara, batang skala terhitung, *extent* koordinat, dan legenda dinamis, serta laporan PDF multi-halaman dengan status sinkronisasi dan ukuran geometri yang tervalidasi. |
| **BUG-09** | **Tinggi** | `script.js` baris 125–189 (`GISExtendedToolbar`) & `style.css` baris 94–113 | Toolbar hanya menampilkan ikon kecil tanpa label teks, dan pada layar mobile (`max-width: 768px`) pseudo-elemen tooltip `::after` disembunyikan (`display: none`), sehingga pengguna smartphone tidak mengetahui fungsi tombol. | Toolbar dirombak menjadi 5 kelompok berlabel teks eksplisit (**Navigasi**, **Penggambaran**, **Pengukuran**, **Survei Lapangan**, **Data & Laporan**) lengkap dengan ikon, teks permanen, dan tooltip tambahan. |
| **BUG-10** | **Sedang** | `style.css` baris 1–154 | Seluruh warna di-*hardcode* ke warna gelap (`#121212`, `#212529`) tanpa variabel tema untuk Mode Terang (*Light Mode*) maupun Mode Sistem (`prefers-color-scheme`), dan pada layar kecil sidebar menutupi 45% peta secara permanen tanpa tombol tutup/buka. | Diimplementasikan sistem *design tokens* CSS Custom Properties untuk **Light Mode**, **Dark Mode**, dan **System Mode**, serta tata letak responsif dengan *collapsible/resizable sidebar* di desktop dan *bottom sheet drawer* di smartphone. |
| **BUG-11** | **Sedang** | `script.js` baris 353–373 & `gadm41_ende.json` | Klik langsung pada poligon/garis di peta tidak membuka panel detail objek. Selain itu, file `gadm41_ende.json` (batas administrasi 20 kecamatan Kab. Ende) ada di repositori tetapi tidak pernah dimuat ke peta. | Ditambahkan event listener klik & hover pada layer `fill-poligon`, `garis-poligon`, dan `garis-jalur` untuk menampilkan detail objek, serta integrasi `gadm41_ende.json` sebagai layer referensi Batas Kecamatan Kab. Ende yang dapat diaktifkan kapan saja. |

## 2. Struktur Google Spreadsheet & Header Setiap Sheet

Aplikasi mempertahankan struktur Google Spreadsheet asli dengan dua sheet utama: **`Markers`** dan **`Shapes`**. Backend `Code.gs` menjaga kompatibilitas penuh dengan kolom lama dan secara otomatis menambahkan kolom ekstensi di sebelah kanan tanpa menghapus atau menggeser data lama.

### A. Sheet `Markers` (Data Titik Lokasi)

| Urutan | Nama Header Kolom | Status Kolom | Tipe Data | Keterangan & Aturan Validasi |
| :---: | :--- | :--- | :--- | :--- |
| 1 | `ID` | Wajib (Asli) | String | Identitas unik objek (wajib ada dan unik per baris). |
| 2 | `Nama` | Wajib (Asli) | String | Nama titik lokasi (maks. 200 karakter, diamankan dari formula injection). |
| 3 | `Kategori` | Wajib (Asli) | String | Kategori objek (mis. `Puskesmas`, `Kantor Kepala Desa`). |
| 4 | `Deskripsi` | Wajib (Asli) | String | Informasi detail, kondisi lapangan, atau demografi. |
| 5 | `Icon` | Wajib (Asli) | String | Kelas ikon FontAwesome 6 (mis. `fa-location-dot`, `fa-school`). |
| 6 | `Lat` | Wajib (Asli) | Number | Garis Lintang (*Latitude*) dalam rentang `-90` s/d `90` (presisi 6–7 desimal). |
| 7 | `Lng` | Wajib (Asli) | Number | Garis Bujur (*Longitude*) dalam rentang `-180` s/d `180` (presisi 6–7 desimal). |
| 8 | `Status` | Wajib (Asli) | String | `Active` untuk objek aktif, `Deleted` untuk penghapusan logis (*soft delete*). |
| 9 | `Timestamp` | Wajib (Asli) | ISO-8601 String | Waktu penyimpanan/pembaruan terakhir di server. |
| 10 | `Warna` | Ekstensi Baru | HEX String | Warna penanda titik dalam format HEX valid (mis. `#0d6efd`). |
| 11 | `UkuranMarker` | Ekstensi Baru | Number | Diameter visual marker dalam piksel (`24` s/d `56`, default `34`). |
| 12 | `CreatedAt` | Ekstensi Baru | ISO-8601 String | Waktu pertama kali objek dibuat. |
| 13 | `UpdatedAt` | Ekstensi Baru | ISO-8601 String | Waktu pembaruan terakhir objek. |
| 14 | `CreatedBy` | Ekstensi Baru | String | Pembuat data (mis. `admin`). |
| 15 | `UpdatedBy` | Ekstensi Baru | String | Pengubah terakhir data. |
| 16 | `Source` | Ekstensi Baru | String | Sumber koordinat (`WebGIS`, `GPS_Point`, `GeoJSON_Import`). |
| 17 | `AccuracyMeters` | Ekstensi Baru | Number | Estimasi akurasi Geolocation browser dalam meter (jika diambil via GPS). |
| 18 | `ClientId` | Ekstensi Baru | String | Identitas sesi perangkat pengirim untuk audit sinkronisasi. |

### B. Sheet `Shapes` (Data Poligon Wilayah & Garis/Jalur)

| Urutan | Nama Header Kolom | Status Kolom | Tipe Data | Keterangan & Aturan Validasi |
| :---: | :--- | :--- | :--- | :--- |
| 1 | `ID` | Wajib (Asli) | String | Identitas unik poligon/garis. |
| 2 | `Nama` | Wajib (Asli) | String | Nama wilayah, lahan, atau ruas jalan/sungai. |
| 3 | `Kategori` | Wajib (Asli) | String | Kategori tata ruang/infrastruktur. |
| 4 | `Deskripsi` | Wajib (Asli) | String | Keterangan detail objek. |
| 5 | `WarnaArea` | Wajib (Asli) | HEX String | Warna isian poligon dalam format HEX valid (mis. `#198754`). |
| 6 | `WarnaGaris` | Wajib (Asli) | HEX String | Warna garis batas poligon atau warna jalur `LineString` (mis. `#4dd4ac`). |
| 7 | `Opacity` | Wajib (Asli) | Number | Transparansi isian poligon dalam rentang `0.05` s/d `0.95` (default `0.35`). |
| 8 | `GeoJSON` | Wajib (Asli) | JSON String | Objek geometri GeoJSON standar (`Polygon`, `MultiPolygon`, `LineString`) dengan urutan koordinat `[longitude, latitude]`. |
| 9 | `Status` | Wajib (Asli) | String | `Active` atau `Deleted` (*soft delete*). |
| 10 | `Timestamp` | Wajib (Asli) | ISO-8601 String | Waktu sinkronisasi server. |
| 11 | `KetebalanGaris` | Ekstensi Baru | Number | Ketebalan garis batas/jalur dalam piksel (`1` s/d `12`, default `2.5`). |
| 12 | `LineOpacity` | Ekstensi Baru | Number | Opacity garis batas terpisah dari opacity isian (`0.1` s/d `1.0`, default `0.92`). |
| 13 | `GeometryType` | Ekstensi Baru | String | Tipe geometri tervalidasi (`Polygon`, `MultiPolygon`, `LineString`). |
| 14 | `LuasM2` | Ekstensi Baru | Number | Luas area tervalidasi dalam meter persegi ($m^2$) menggunakan perhitungan geodesik Turf.js. |
| 15 | `PanjangM` | Ekstensi Baru | Number | Panjang jalur atau keliling poligon dalam meter ($m$). |
| 16 | `CreatedAt` | Ekstensi Baru | ISO-8601 String | Waktu pembuatan awal. |
| 17 | `UpdatedAt` | Ekstensi Baru | ISO-8601 String | Waktu pembaruan terakhir. |
| 18 | `CreatedBy` | Ekstensi Baru | String | Pembuat objek. |
| 19 | `UpdatedBy` | Ekstensi Baru | String | Pengubah terakhir objek. |
| 20 | `Source` | Ekstensi Baru | String | Sumber geometri (`WebGIS`, `GPS_Survey_Track`, `GeoJSON_Import`). |
| 21 | `ClientId` | Ekstensi Baru | String | Identitas sesi perangkat pengirim. |

## 3. Dokumentasi Konfigurasi API & Mapbox

1. **Konfigurasi Default**:
   Secara bawaan, `script.js` mempertahankan variabel `API_URL` dan token publik Mapbox GL JS yang sudah ada pada project asli sehingga aplikasi langsung berjalan tanpa perlu mengubah struktur HTML.
2. **Menggunakan File Konfigurasi Eksternal (`config.js`)**:
   Jika Anda ingin mengganti URL Web App Google Apps Script atau menggunakan token Mapbox baru tanpa menyentuh `script.js`:
   - Salin file `config.example.js` menjadi `config.js`.
   - Isi `window.GIS_CONFIG.API_URL` dan `window.GIS_CONFIG.MAPBOX_TOKEN`.
   - Tambahkan `<script src="config.js"></script>` tepat sebelum `<script src="script.js"></script>` pada `index.html`.
3. **Keamanan Token**:
   - Gunakan **Public Token (`pk.***`)** Mapbox dengan pembatasan *URL Restrictions* pada dashboard Mapbox Anda agar token hanya dapat digunakan di domain resmi portal GIS Anda.
   - Jangan pernah menaruh *Secret Token (`sk.***`)* di kode frontend maupun menyimpannya di `localStorage`.

## 4. Petunjuk Deployment & Otorisasi Google Apps Script (`Code.gs`)

1. Buka Google Spreadsheet penyimpanan utama Anda yang memiliki sheet **`Markers`** dan **`Shapes`**.
2. Klik menu **Ekstensi (Extensions) > Apps Script**.
3. Ganti isi file `Code.gs` di editor Apps Script dengan seluruh kode dari file **`Code.gs`** yang disertakan dalam project ini, lalu tekan **Ctrl+S** (Simpan).
4. (Opsional) Untuk memastikan seluruh kolom ekstensi baru terbuat secara otomatis tanpa menyentuh data lama, Anda dapat menjalankan fungsi atau mengirim aksi `migrate_schema`, atau cukup lakukan penyimpanan pertama dari aplikasi karena `ensureSheetAndHeaders_()` otomatis melakukan migrasi kolom secara aman.
5. Klik tombol **Terapkan (Deploy) > Deployment baru (New deployment)** atau **Kelola deployment (Manage deployments)** jika ingin memperbarui URL yang sudah ada:
   - Pilih jenis: **Aplikasi Web (Web app)**.
   - **Jalankan sebagai (Execute as)**: **Saya (Me)**.
   - **Siapa yang memiliki akses (Who has access)**: **Siapa saja (Anyone)**.
6. Klik **Terapkan (Deploy)**, tinjau izin akses (*Review Permissions*), pilih akun Google pemilik Spreadsheet, klik **Advanced > Go to Project (unsafe)** bila muncul peringatan verifikasi aplikasi internal, lalu klik **Allow (Izinkan)**.
7. Salin **URL Aplikasi Web (`https://script.google.com/macros/s/.../exec`)** dan pastikan terpasang pada `API_URL`.

## 5. Petunjuk Penggunaan GPS, Survei Lapangan, dan Persyaratan HTTPS

### Persyaratan Lingkungan & Privasi
- **Konteks Aman (HTTPS / Localhost)**: Standar keamanan browser modern mewajibkan Geolocation API dijalankan melalui protokol **`https://`** atau **`http://localhost`** / **`http://127.0.0.1`**. Membuka file secara langsung melalui `file://` pada beberapa browser dapat memblokir akses sensor lokasi.
- **Privasi & Persetujuan**: Aplikasi tidak pernah meminta izin lokasi saat halaman baru dibuka. Permintaan izin lokasi hanya dipicu ketika pengguna menekan tombol GPS, dan koordinat tidak dikirim ke Google Spreadsheet sebelum pengguna menekan tombol **Simpan ke Draft** dan **Simpan Permanen**.

### Cara Menambahkan Titik dari Lokasi GPS Saya
1. Login sebagai Admin, lalu klik tombol **Tambah Titik GPS** pada toolbar **Survei Lapangan** (atau buka panel **Gunakan GPS** lalu klik **Tambahkan Titik dari Lokasi Saya**).
2. Browser akan mengambil koordinat `latitude`, `longitude`, dan nilai estimasi `accuracy` (dalam meter).
3. Formulir atribut akan terbuka secara otomatis dengan pratinjau koordinat dan estimasi akurasi browser. Anda tetap dapat mengoreksi posisi secara manual sebelum menekan **Simpan ke Draft**.

### Cara Merekam Area / Batas Wilayah Menggunakan GPS (Survei Lapangan)
1. Buka panel **Gunakan GPS** pada grup toolbar **Survei Lapangan**.
2. Pilih **Bentuk Survei**: **Poligon (Area Wilayah)** atau **Garis (Jalur / Jalan)**.
3. Atur **Min Jarak (m)** (default `3` meter agar titik tidak menumpuk saat berhenti berjalan) dan **Maks Akurasi (m)** (default `50` meter untuk menyaring lonjakan sinyal GPS yang buruk).
4. Klik **Mulai Rekam Lokasi** dan berjalanlah mengikuti batas wilayah. Setiap sampel koordinat akan langsung menggambar jejak hijau di peta. Anda juga dapat menekan tombol **+ Titik** untuk mengambil sampel titik sudut secara manual.
5. Tinjau daftar titik pada panel; hapus titik yang menyimpang dengan tombol **X** di samping nomor sampel.
6. Klik **Hentikan Rekaman**, lalu klik **Selesaikan Survei & Simpan Hasil**. Untuk poligon, cincin koordinat akan otomatis ditutup (`ring[0] === ring[n-1]`) dan dihitung luasnya sebelum masuk ke formulir atribut.

## 6. Petunjuk Penggunaan Setiap Tools GIS

| Kelompok Toolbar | Nama Tool Berlabel | Fungsi & Cara Penggunaan |
| :--- | :--- | :--- |
| **Navigasi** | **Perbesar Peta / Perkecil Peta** | Memperbesar atau memperkecil skala tampilan peta secara bertahap. |
| **Navigasi** | **Tampilan Awal** | Mengembalikan kamera peta ke koordinat pusat wilayah awal (`[121.662, -8.840]`). |
| **Navigasi** | **Lokasi Saya** | Mendeteksi posisi perangkat saat ini dan memusatkan peta ke lokasi tersebut. |
| **Navigasi** | **Pencarian Lokasi** | Mencari objek berdasarkan nama, kategori, deskripsi, atau melompat ke koordinat `Lat, Lng`. |
| **Navigasi** | **Pilih Basemap** | Mengganti peta dasar antara **Peta Jalan** (otomatis mengikuti Mode Terang/Gelap), **Satelit Hibrida**, dan **Topografi**. |
| **Navigasi** | **Tampilkan Layer** | Membuka pengaturan visibilitas layer (Markers, Shapes, Batas Kecamatan GADM Ende, Gedung 3D) dan pengaturan ukuran/warna/halo **Label Geografis**. |
| **Navigasi** | **Koordinat Kursor** | Menampilkan koordinat `Lat` dan `Lng` secara langsung mengikuti pergerakan kursor/sentuhan beserta tombol salin. |
| **Penggambaran** | **Pilih Objek** | Mengaktifkan mode pilih standar untuk mengklik objek di peta dan melihat detailnya. |
| **Penggambaran** | **Tambah Titik** | Menempatkan marker titik baru dengan mengklik lokasi di peta. |
| **Penggambaran** | **Gambar Garis** | Menggambar jaringan jalan, sungai, atau saluran irigasi (`LineString`). |
| **Penggambaran** | **Gambar Poligon** | Menggambar batas wilayah, lahan pertanian, atau kawasan (`Polygon`). |
| **Penggambaran** | **Gambar Persegi Panjang / Lingkaran** | Membuat geometri persegi panjang atau lingkaran terukur di tengah tampilan peta dan langsung membuka formulir properti. |
| **Penggambaran** | **Edit Geometri** | Mengaktifkan mode pengeditan titik sudut (*vertex*) pada poligon/garis yang sedang dipilih. Klik **Selesaikan Gambar** setelah selesai menggeser titik. |
| **Penggambaran** | **Pindahkan Objek** | Memindahkan posisi marker atau objek terpilih dengan menyeretnya (*drag*) di peta. |
| **Penggambaran** | **Hapus Geometri** | Melakukan *Soft Delete* (`Status: 'Deleted'`) pada objek terpilih dengan dialog konfirmasi. |
| **Penggambaran** | **Batalkan (Undo) / Ulangi (Redo)** | Membatalkan atau mengulangi hingga 30 langkah perubahan terakhir pada antrean Draft. |
| **Penggambaran** | **Selesaikan / Batal Menggambar** | Menyelesaikan penggambaran geometri aktif (sangat membantu di layar sentuh smartphone) atau membatalkannya. |
| **Pengukuran** | **Ukur Jarak / Luas / Radius** | Menghitung jarak lintasan ($m / km$), luas poligon ($m^2 / Ha$), atau radius jangkauan lingkaran secara real-time menggunakan Turf.js. |
| **Data & Laporan** | **Simpan Perubahan / Sinkronkan Data** | Mengirim seluruh antrean Draft ke Google Spreadsheet atau memuat ulang data terbaru dari server. |
| **Data & Laporan** | **Impor / Ekspor GeoJSON** | Mengimpor file/teks GeoJSON standar ke dalam Draft atau mengunduh seluruh objek aktif menjadi file `.geojson`. |
| **Data & Laporan** | **Ekspor JPG / Ekspor PDF** | Membuka Studio Ekspor Kartografis untuk mengunduh peta beresolusi tinggi (JPG/PNG) atau dokumen laporan PDF multi-halaman. |

## 7. Dokumentasi Ekspor Kartografis JPG/PNG dan PDF

Fitur ekspor telah ditingkatkan dari sekadar tangkapan layar menjadi **Studio Ekspor Kartografis** (`buildCartographicCanvas` & `executeCartographicExport`):
- **Pilihan Format & Kualitas**: Mendukung **JPG**, **PNG** (garis dan teks tajam), serta **PDF** (A4 Landscape atau Portrait) dengan pilihan resolusi **1x (Standar)**, **1.5x (Tinggi)**, dan **2x (Ultra/Cetak)**.
- **Elemen Kartografis Lengkap**: Menyertakan Header Judul Peta, Subjudul Wilayah, Identitas Instansi, Kompas Arah Utara, Batang Skala Peta yang dihitung secara matematis berdasarkan garis lintang & level zoom (`156543.03 * cos(lat) / 2^zoom`), Batas Koordinat Tampilan (*Map Extent*), Legenda Kategori Dinamis, Label Nama Objek, dan Waktu Ekspor.
- **Laporan PDF Multi-Halaman**:
  - **Halaman 1**: Bingkai Peta Kartografis penuh beserta ringkasan statistik jumlah objek (Titik Lokasi vs Area/Jalur) dan metadata skala/extent.
  - **Halaman 2+**: Tabel inventaris objek yang memuat Nomor, Nama Objek, Kategori, Jenis Geometri, Koordinat Pusat/Titik, Luas ($m^2$) atau Panjang ($m$) yang telah tervalidasi, serta Status Sinkronisasi yang akurat (`Tersinkronisasi` vs `Draft Lokal`).

## 8. Daftar Fitur yang Sudah Diuji & Pengujian Manual Lanjutan

### A. Fitur yang Telah Diuji dan Diverifikasi
- Validasi sintaks JavaScript ES6+ (`node --check`) dan pemeriksaan integritas DOM/ID/Handler (`check_web_app.py`) dengan hasil **0 Error dan 0 Warning**.
- Alur Login Admin (`admin` / `stpm2026`) dan Logout dengan proteksi peringatan Draft yang belum disimpan.
- Penggabungan data server & draft lokal (`getMergedActiveData`) serta penyaringan ketat objek berstatus `Deleted` (*Soft Delete*) di seluruh komponen UI dan ekspor.
- Pengaturan warna isian (`WarnaArea`/`Warna`), warna garis (`WarnaGaris`), transparansi isian (`Opacity`), ketebalan garis (`KetebalanGaris`), ukuran marker (`UkuranMarker`), dan ikon (`Icon`) beserta pratinjau langsung.
- Persistensi antrean Draft di `localStorage` dan pemulihan otomatis saat halaman dimuat ulang.
- Pergantian tema **Terang (Light)**, **Gelap (Dark)**, dan **Sistem (System)** beserta adaptasi kontras teks, form input, dan basemap.
- Simulasi perekaman titik GPS, perhitungan luas/jarak/radius menggunakan Turf.js, impor/ekspor GeoJSON, serta komposisi kanvas ekspor JPG/PNG/PDF.

### B. Fitur yang Memerlukan Pengujian Manual pada Lingkungan Produksi Pengguna
- **Otorisasi & Eksekusi Deployment Baru `Code.gs`**: Karena deployment Google Apps Script terikat pada akun Google pemilik Spreadsheet, pengguna perlu menyalin kode `Code.gs` yang telah diperbaiki ke editor Apps Script pada Spreadsheet miliknya dan melakukan *Update Deployment*.
- **Uji Jalan Lapangan GPS Fisik (Outdoor Walk Test)**: Pengujian akurasi sensor GPS perangkat fisik sambil berjalan mengelilingi persil lahan pada smartphone Android dan iPhone melalui koneksi HTTPS.
