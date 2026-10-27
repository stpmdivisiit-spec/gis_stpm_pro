/**
 * Konfigurasi Opsional Portal GIS Terpadu (config.example.js)
 * Salin file ini menjadi `config.js` dan muat sebelum `script.js` bila Anda ingin
 * memisahkan URL endpoint Google Apps Script atau token Mapbox tanpa mengubah `script.js`.
 */
window.GIS_CONFIG = {
    // Pertahankan URL Web App Google Apps Script Anda yang aktif:
    API_URL: 'https://script.google.com/macros/s/GANTI_DENGAN_DEPLOYMENT_ID_ANDA/exec',

    // Masukkan Public Access Token Mapbox GL JS (pk.***):
    MAPBOX_TOKEN: 'pk.GANTI_DENGAN_PUBLIC_TOKEN_MAPBOX_ANDA'
};
