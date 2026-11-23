import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Page } from 'playwright-core';

/*
 * Clicks through every page in a real browser against the simulator and saves screenshots.
 * BASE = the LocalRock Web address, OUT = folder for the PNGs, CHROME = path to chrome.exe.
 */

const BASE = process.env['BASE'] ?? 'http://127.0.0.1:8080';
const OUT = process.env['OUT'] ?? 'screenshots';
const CHROME = process.env['CHROME'] ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
mkdirSync(OUT, { recursive: true });

const problems: string[] = [];
const DUID = 'SimS8ProUltra01';

async function shot(page: Page, name: string): Promise<void> {
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(OUT, `${name}.png`) });
  console.log(`shot ${name}`);
}

async function openVac(page: Page, tab = ''): Promise<void> {
  await page.goto(`${BASE}/#/vac/${DUID}${tab ? `/${tab}` : ''}`);
}

async function mapBox(page: Page) {
  const canvas = page.locator('canvas.map-canvas').first();
  await canvas.waitFor({ timeout: 30_000 });
  await page.waitForTimeout(1200);
  return (await canvas.boundingBox())!;
}

async function main() {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));

  // Sign-in
  await page.goto(BASE);
  await page.getByText('Connect to your server').waitFor();
  await shot(page, '01-server');
  await page.getByPlaceholder('https://192.168.1.10:555').fill('https://127.0.0.1:8443');
  await page.getByRole('switch').check();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByText('Sign in', { exact: true }).first().waitFor();
  await page.locator('input[type=email]').fill('me@example.com');
  await page.locator('input[type=password]').fill('000000');
  await shot(page, '02-login');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByText(/invalid code/).waitFor();
  await shot(page, '03-login-error');
  await page.locator('input[type=password]').fill('123456');
  await page.getByRole('button', { name: 'Sign in' }).click();

  // Home: robot cards with live state and map previews
  await page.getByRole('heading', { name: 'Vacuums' }).waitFor();
  await page.locator('.robot-card .map-thumb').nth(1).waitFor({ timeout: 30_000 });
  await page.locator('.robot-card .battery').nth(1).waitFor({ timeout: 30_000 });
  await shot(page, '04-home');

  // Overview
  await page.locator('.robot-card', { hasText: 'S8 Pro Ultra (simulated)' }).getByRole('link', { name: 'Open', exact: true }).click();
  const box = await mapBox(page);
  await shot(page, '05-overview');
  // The map turned a quarter turn, then the 3D model, dragged round with the right button
  await page.getByRole('button', { name: 'Rotate the map 90°' }).click();
  await shot(page, '05b-rotated');
  await page.getByRole('button', { name: '2D', exact: true }).click();
  await shot(page, '05c-3d');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2 - 60, { steps: 8 });
  await page.mouse.up({ button: 'right' });
  await shot(page, '05d-3d-turned');
  await page.getByRole('button', { name: '3D', exact: true }).click();
  await page.getByRole('button', { name: 'Rotate the map 90°' }).click();
  await page.getByRole('button', { name: 'Rotate the map 90°' }).click();
  await page.getByRole('button', { name: 'Rotate the map 90°' }).click();
  await page.waitForTimeout(300);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.getByRole('button', { name: 'Clean 1 room' }).waitFor({ timeout: 5_000 });
  await page.getByRole('button', { name: 'None' }).click();
  await page.locator('.room-row', { hasText: 'Kitchen' }).click();
  await page.locator('.room-row', { hasText: 'Living room' }).hover();
  await page.locator('.room-row', { hasText: 'Living room' }).click();
  await shot(page, '06-rooms-picked');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Pick rooms to clean' }).waitFor();

  await page.getByRole('button', { name: 'More actions' }).click();
  await shot(page, '07-menu');
  await page.keyboard.press('Escape');
  await page.keyboard.press('?');
  await page.getByRole('heading', { name: 'Keyboard shortcuts' }).waitFor();
  await shot(page, '08-shortcuts');
  await page.keyboard.press('Escape');

  await page.getByRole('group', { name: 'Mode' }).getByRole('button', { name: 'Per room' }).click();
  await page.getByRole('button', { name: 'Room settings' }).waitFor({ timeout: 15_000 });
  await page.getByRole('button', { name: 'Room settings' }).click();
  await page.locator('.modal table').waitFor({ timeout: 15_000 });
  await shot(page, '09-room-settings');
  await page.keyboard.press('Escape');
  await page.getByRole('group', { name: 'Mode' }).getByRole('button', { name: 'Manual' }).click();
  await page.getByLabel('Suction').waitFor({ timeout: 15_000 });
  await shot(page, '10-cleaning-mode');

  await page.getByRole('button', { name: 'Maps', exact: true }).click();
  await page.getByText('Loaded', { exact: true }).waitFor({ timeout: 15_000 });
  await shot(page, '11-maps');
  await page.keyboard.press('Escape');

  // A clean, started with the keyboard
  await page.keyboard.press('c');
  await page.locator('.chip-status', { hasText: 'Cleaning' }).waitFor({ timeout: 15_000 });
  await page.waitForTimeout(3000);
  await shot(page, '12-cleaning');
  await page.getByRole('button', { name: 'Dock' }).click();

  // Zone and Pin & Go tools on the same map
  await page.getByRole('group', { name: 'Map tool' }).getByRole('button', { name: 'Zones' }).click();
  await page.mouse.move(box.x + box.width * 0.42, box.y + box.height * 0.38);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.52, { steps: 8 });
  await page.mouse.up();
  await page.getByRole('button', { name: 'Clean 1 zone' }).waitFor();
  await shot(page, '13-zones');
  await page.getByRole('group', { name: 'Map tool' }).getByRole('button', { name: 'Pin & Go' }).click();
  await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.45);
  await shot(page, '14-pin');

  // Tabs
  await page.getByRole('link', { name: 'Settings', exact: true }).last().click();
  await page.getByRole('heading', { name: 'Default cleaning order' }).waitFor();
  await page.waitForTimeout(800);
  await shot(page, '15-settings');
  await page.getByRole('button', { name: 'Cleaning order' }).click();
  await shot(page, '16-settings-order');
  await page.getByRole('link', { name: 'History' }).last().click();
  await page.getByText('Working Times').waitFor({ timeout: 15_000 });
  await shot(page, '17-history');
  await page.locator('tr.clickable').first().click();
  await page.getByText('Cleaning Finished').waitFor({ timeout: 30_000 });
  await shot(page, '17b-history-run');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Cruise' }).click();
  await page.locator('tr.clickable').first().click();
  await page.locator('img[alt="Point 1 photo 1"]').waitFor({ timeout: 40_000 });
  await shot(page, '17c-history-cruise');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Cleaning' }).click();
  await page.getByRole('link', { name: 'Maintenance' }).click();
  await page.getByText('Main brush').waitFor({ timeout: 15_000 });
  await shot(page, '18-maintenance');
  await page.getByRole('link', { name: 'Schedule' }).click();
  await page.getByText('Weekdays').waitFor({ timeout: 15_000 });
  await shot(page, '19-schedule');
  await page.getByRole('button', { name: 'Add schedule' }).click();
  await shot(page, '20-schedule-add');
  await page.keyboard.press('Escape');
  await page.getByRole('link', { name: 'Remote' }).click();
  await shot(page, '21-remote');
  await page.getByRole('link', { name: 'Camera' }).click();
  await page.getByText('Type a PIN instead').waitFor();
  await shot(page, '22-camera');
  await page.getByText('Type a PIN instead').click();
  await page.locator('input[type=password]').fill('1234');
  await page.getByText('Start live view').click();
  await page.getByText(/-1007/).waitFor({ timeout: 15_000 });
  await shot(page, '23-camera-error');

  // Map editor
  await page.getByRole('link', { name: 'Edit map' }).first().click();
  await page.getByText('Add to map').waitFor({ timeout: 15_000 });
  await page.waitForTimeout(1200);
  await shot(page, '24-editor');
  await page.getByRole('button', { name: 'Add no-go' }).click();
  await shot(page, '25-editor-nogo');
  // Leaving with unsaved edits asks first.
  await page.getByRole('link', { name: 'Overview' }).click();
  await page.getByText('Discard changes?').waitFor();
  await shot(page, '26-editor-leave');
  await page.getByRole('alertdialog').getByRole('button', { name: 'Cancel' }).click();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Add carpet' }).click();
  await page.getByRole('button', { name: 'Done' }).click();
  await page.getByRole('button', { name: 'Save to robot' }).click();
  await shot(page, '27-editor-save-confirm');
  await page.getByRole('alertdialog').getByRole('button', { name: 'Save' }).click();
  await page.getByText(/Saved\. The robot's map shows the changes\./).waitFor({ timeout: 30_000 });
  await shot(page, '28-editor-saved');
  await page.getByRole('group', { name: 'Edit mode' }).getByRole('button', { name: 'Rooms' }).click();
  await page.locator('.room-row', { hasText: 'Kitchen' }).click();
  await page.waitForTimeout(800);
  await shot(page, '29-editor-rooms');

  // The second robot speaks the B01 protocol
  await page.goto(`${BASE}/#/vac/SimQrevoCurv02`);
  await mapBox(page);
  await shot(page, '30-b01');

  await page.goto(`${BASE}/#/add`);
  await shot(page, '31-add');
  await page.goto(`${BASE}/#/settings`);
  await shot(page, '32-app-settings');

  // A smaller laptop window
  await page.setViewportSize({ width: 1180, height: 760 });
  await openVac(page);
  await mapBox(page);
  await shot(page, '33-laptop-overview');
  await page.setViewportSize({ width: 1440, height: 900 });

  // Dark theme
  await page.emulateMedia({ colorScheme: 'dark' });
  await openVac(page);
  await mapBox(page);
  await shot(page, '34-dark-overview');
  await page.getByRole('button', { name: '2D', exact: true }).click();
  await shot(page, '34b-dark-3d');
  await page.getByRole('button', { name: '3D', exact: true }).click();
  await page.goto(`${BASE}/#/`);
  await page.locator('.robot-card .map-thumb').nth(1).waitFor({ timeout: 30_000 });
  await shot(page, '35-dark-home');
  await openVac(page, 'settings');
  await page.getByRole('heading', { name: 'Default cleaning order' }).waitFor();
  await shot(page, '36-dark-settings');
  await openVac(page, 'edit');
  await page.getByText('Add to map').waitFor({ timeout: 15_000 });
  await page.waitForTimeout(1000);
  await shot(page, '37-dark-editor');

  // Phone size: the sidebar becomes a drawer, panels stack under the map
  const phone = await browser.newContext({ viewport: { width: 412, height: 860 }, deviceScaleFactor: 2, colorScheme: 'light', hasTouch: true, isMobile: true });
  const p2 = await phone.newPage();
  p2.on('pageerror', (e) => problems.push(`pageerror(phone): ${e.message}`));
  await openVac(p2);
  await mapBox(p2);
  await shot(p2, '38-phone-overview');
  await p2.getByRole('button', { name: 'Open navigation' }).click();
  await shot(p2, '39-phone-drawer');
  await openVac(p2, 'edit');
  await p2.getByText('Add to map').waitFor({ timeout: 15_000 });
  await shot(p2, '40-phone-editor');

  await browser.close();
  console.log(problems.length ? `\nPROBLEMS:\n${problems.join('\n')}` : '\nNo console or page errors.');
}

main().catch((e) => {
  console.error(e);
  console.log(problems.length ? `\nPROBLEMS:\n${problems.join('\n')}` : '');
  process.exit(1);
});
