const { app } = require('electron');
const { createShellWindow, installMinimalMenu } = require('@kiu/desktop-shell');

const URL = process.env.KIU_READER_URL ?? 'http://192.168.100.179:3002';

app.whenReady().then(() => {
  installMinimalMenu();
  createShellWindow({ url: URL, title: 'KIU Reader' });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
