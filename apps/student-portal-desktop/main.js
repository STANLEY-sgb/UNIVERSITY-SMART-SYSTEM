const { app } = require('electron');
const { createShellWindow, installMinimalMenu } = require('@kiu/desktop-shell');

const URL = process.env.KIU_WALLET_URL ?? 'http://192.168.100.179:3001';

app.whenReady().then(() => {
  installMinimalMenu();
  createShellWindow({ url: URL, title: 'KIU Wallet' });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
