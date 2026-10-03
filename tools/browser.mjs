// SPDX-License-Identifier: GPL-3.0-or-later
// Shared puppeteer-core helpers for the emulation scripts (system Chrome/Edge, no Chromium download).
import puppeteer from 'puppeteer-core';
import { existsSync } from 'node:fs';

const CANDIDATES = [
  process.env.CHROME, process.env.PUPPETEER_EXECUTABLE_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

export function findChrome() {
  const p = CANDIDATES.find(c => existsSync(c));
  if (!p) throw new Error('No Chrome/Edge found: set CHROME=<path to chrome>');
  return p;
}

export async function launch({ width = 1280, height = 800, headed = false, gpu = true } = {}) {
  const args = [`--window-size=${width},${height}`, '--no-first-run', '--no-default-browser-check', '--autoplay-policy=no-user-gesture-required',
    '--ignore-gpu-blocklist', '--enable-webgl'];
  if (!gpu) args.push('--use-angle=swiftshader', '--enable-unsafe-swiftshader');
  const browser = await puppeteer.launch({ executablePath: findChrome(), headless: headed ? false : 'new', args, defaultViewport: { width, height } });
  return browser;
}

export async function openPage(browser, url, { log = [], timeout = 120000 } = {}) {
  const page = await browser.newPage();
  page.on('console', m => { const tx = m.text(); if (m.type() === 'error' || m.type() === 'warn' || /\[(xr|avatar|viewer)\]/.test(tx)) log.push(`${m.type()}: ${tx}`); });
  page.on('pageerror', e => log.push(`pageerror: ${e.message}`));
  page.on('requestfailed', r => log.push(`requestfailed: ${r.url()} ${r.failure()?.errorText}`));
  await page.goto(url, { waitUntil: 'load', timeout });
  await page.waitForFunction('window.__ready === true', { timeout, polling: 250 });
  return page;
}

export const sleep = ms => new Promise(r => setTimeout(r, ms));
