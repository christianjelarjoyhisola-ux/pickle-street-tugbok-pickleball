const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const graphic = require('./availability-graphic.js');

function fakeCanvas() {
  const calls = [];
  const gradient = { addColorStop() {} };
  const context = {
    beginPath() {},
    moveTo() {},
    lineTo() {},
    arcTo() {},
    closePath() {},
    arc() {},
    fill() {},
    stroke() {},
    save() {},
    restore() {},
    clearRect() {},
    fillRect() {},
    fillText(value, x, y) { calls.push({ type: 'fillText', value: String(value), x, y }); },
    drawImage() {},
    createLinearGradient() { return gradient; },
    createRadialGradient() { return gradient; },
    measureText(value) { return { width: String(value).length * 11 }; },
  };
  return {
    width: 0,
    height: 0,
    calls,
    getContext(kind) { return kind === '2d' ? context : null; },
  };
}

test('normalizes the production availability graphic contract without carrying PII', () => {
  const snapshot = graphic.normalizeSnapshot({
    version: 1,
    date: '2026-09-20',
    timezone: 'Asia/Manila',
    asOf: '2026-09-02T12:15:00.000Z',
    customerName: 'Must Not Appear',
    courts: [{
      id: 'court-a',
      name: 'Center Court',
      availableCount: 1,
      totalSlots: 12,
      slots: [{
        hour: 6,
        startLabel: '6:00 AM',
        endLabel: '7:00 AM',
        state: 'free',
        label: '6:00 AM - 7:00 AM',
        customer_name: 'Also Must Not Appear',
      }],
    }],
  });

  assert.equal(snapshot.generatedAt, '2026-09-02T12:15:00.000Z');
  assert.equal(snapshot.courts[0].slots[0].status, 'available');
  assert.equal(snapshot.courts[0].slots[0].start, 6);
  assert.equal(snapshot.courts[0].slots[0].end, 7);
  assert.equal(JSON.stringify(snapshot).includes('Must Not Appear'), false);
});

test('tolerates snake_case court maps and available-slot arrays', () => {
  const snapshot = graphic.normalizeSnapshot({
    schedule_date: '2026-09-21',
    generated_at: '2026-09-02T13:00:00.000Z',
    court_availability: {
      alpha: {
        court_name: 'Court Alpha',
        available_slots: ['8:00 AM - 9:00 AM', '9:00 AM - 10:00 AM'],
      },
    },
  });
  assert.equal(snapshot.courts[0].id, 'alpha');
  assert.equal(snapshot.courts[0].name, 'Court Alpha');
  assert.deepEqual(graphic.mergeAvailableRanges(snapshot.courts[0].slots), [
    { start: 8, end: 10, label: '8–10 AM' },
  ]);
});

test('merges consecutive slots, preserves gaps, and formats noon and 12 AM', () => {
  const ranges = graphic.mergeAvailableRanges([
    { start: 10, end: 11, status: 'available' },
    { start: 11, end: 13, status: 'available' },
    { start: 13, end: 14, status: 'booked' },
    { start: 15, end: 16, status: 'available' },
    { start: 23, end: 24, status: 'available' },
  ]);
  assert.deepEqual(ranges, [
    { start: 10, end: 13, label: '10 AM–1 PM' },
    { start: 15, end: 16, label: '3–4 PM' },
    { start: 23, end: 24, label: '11 PM–12 AM' },
  ]);
});

test('end-of-day ranges use the requested 12 AM label', () => {
  assert.deepEqual(graphic.mergeAvailableRanges([
    { start: 18, end: 24, status: 'available' },
  ]), [{ start: 18, end: 24, label: '6 PM–12 AM' }]);
  assert.deepEqual(graphic.mergeAvailableRanges([
    { start: 6, end: 24, status: 'available' },
  ]), [{ start: 6, end: 24, label: '6 AM–12 AM' }]);
});

test('caption contains only court availability, booking CTA, and freshness disclaimer', () => {
  const caption = graphic.buildCaption({
    date: '2026-09-20',
    asOf: '2026-09-02T11:42:00.000Z',
    customerName: 'Hidden Customer',
    courts: [{
      id: '1',
      name: 'Court One',
      slots: [{ hour: 18, end: 20, status: 'available' }],
    }],
  });
  assert.match(caption, /Court One: 6–8 PM/);
  assert.match(caption, /Slots may change/);
  assert.match(caption, /pickle-street-tugbok\.boothsandbeyondoffic\.chatgpt\.site/);
  assert.doesNotMatch(caption, /Hidden Customer/);
});

test('feed and story renderers set exact Facebook canvas dimensions', async () => {
  const snapshot = graphic.normalizeSnapshot({
    date: '2026-09-20',
    asOf: '2026-09-02T12:00:00.000Z',
    courts: [{ id: '1', name: 'Court One', slots: [{ hour: 7, end: 9, state: 'free' }] }],
  });
  const feed = fakeCanvas();
  const story = fakeCanvas();
  await graphic.drawPoster(feed, snapshot, 'feed', { logo: false, qr: false });
  await graphic.drawPoster(story, snapshot, 'story', { logo: false, qr: false });
  assert.deepEqual([feed.width, feed.height], [1080, 1350]);
  assert.deepEqual([story.width, story.height], [1080, 1920]);
});

test('nine courts become complete, ordered carousel pages in both formats', () => {
  const snapshot = graphic.normalizeSnapshot({
    date: '2026-09-20',
    asOf: '2026-09-02T12:00:00.000Z',
    courts: Array.from({ length: 9 }, (_, index) => ({
      id: `court-${index + 1}`,
      name: `Court ${index + 1}`,
      slots: [{ hour: 6 + index, end: 7 + index, state: 'free' }],
    })),
  });
  ['feed', 'story'].forEach(format => {
    const pages = graphic.paginateSnapshot(snapshot, format);
    assert.equal(pages.length, 3);
    assert.deepEqual(
      pages.flatMap(page => page.courts.map(court => court.id)),
      snapshot.courts.map(court => court.id),
    );
    assert.ok(pages.every(page => page.courts.length <= graphic.posterLayouts[format].capacity));
  });
});

test('court controls, captions, and carousel pages use stable natural court order', () => {
  const courts = Array.from({ length: 10 }, (_, index) => ({
    id: String(10 - index),
    name: `Court ${10 - index}`,
    slots: [{ hour: 7, end: 8, state: 'free' }],
  }));
  const snapshot = graphic.normalizeSnapshot({ date: '2026-09-20', courts });
  const expected = Array.from({ length: 10 }, (_, index) => `Court ${index + 1}`);
  assert.deepEqual(snapshot.courts.map(court => court.name), expected);
  assert.deepEqual(
    graphic.paginateSnapshot(snapshot, 'feed').flatMap(page => page.courts.map(court => court.name)),
    expected,
  );
  const caption = graphic.buildCaption(snapshot);
  expected.slice(0, -1).forEach((name, index) => {
    assert.ok(caption.indexOf(`${name}:`) < caption.indexOf(`${expected[index + 1]}:`));
  });
});

test('long schedules split into readable timeslot pages without dropping any slot', () => {
  const slots = Array.from({ length: 9 }, (_, index) => ({
    hour: index * 2,
    end: index * 2 + 1,
    state: 'free',
  }));
  const snapshot = graphic.normalizeSnapshot({
    date: '2026-09-20',
    courts: [{ id: 'show-court', name: 'Show Court', slots }],
  });
  const pages = graphic.paginateSnapshot(snapshot, 'feed');
  assert.equal(pages.length, 2);
  assert.deepEqual(pages.map(page => page.courts[0].slots.length), [8, 1]);
  assert.deepEqual(
    pages.flatMap(page => page.courts[0].slots.map(slot => slot.start)),
    snapshot.courts[0].slots.map(slot => slot.start),
  );
  assert.ok(pages.every(page => page.courts[0].id === 'show-court'));
});

test('adaptive range grid keeps common and dense schedules readable inside one card', () => {
  const common = graphic.rangeGridLayout(3, { x: 396, y: 517, width: 576, height: 136 }, false);
  assert.equal(common.columns, 1);
  assert.equal(common.rows, 3);
  assert.ok(common.fontSize >= 24);

  const dense = graphic.rangeGridLayout(9, { x: 396, y: 517, width: 576, height: 136 }, false);
  assert.equal(dense.columns, 3);
  assert.equal(dense.rows, 3);
  assert.equal(dense.cells.length, 9);
  assert.ok(dense.fontSize >= 20);
  dense.cells.forEach(cell => {
    assert.ok(cell.x >= 396 && cell.y >= 517);
    assert.ok(cell.x + cell.width <= 972.001);
    assert.ok(cell.y + cell.height <= 653.001);
  });
});

test('every timeslot carousel page keeps the selected court columns together', () => {
  const denseSlots = Array.from({ length: 9 }, (_, index) => ({
    hour: index * 2,
    end: index * 2 + 1,
    state: 'free',
  }));
  const snapshot = graphic.normalizeSnapshot({
    date: '2026-09-20',
    courts: [
      { id: '1', name: 'Court 1', slots: denseSlots },
      { id: '2', name: 'Court 2', slots: [{ hour: 8, end: 9, state: 'free' }] },
      { id: '3', name: 'Court 3', slots: [{ hour: 8, end: 9, state: 'free' }] },
      { id: '4', name: 'Court 4', slots: [{ hour: 8, end: 9, state: 'free' }] },
    ],
  });
  for (const format of ['feed', 'story']) {
    const pages = graphic.paginateSnapshot(snapshot, format);
    assert.deepEqual(pages.map(page => page.courts.length), format === 'feed' ? [4, 4] : [4]);
    const ids = pages.flatMap(page => page.courts.map(court => court.id));
    assert.deepEqual(ids, format === 'feed'
      ? ['1', '2', '3', '4', '1', '2', '3', '4']
      : ['1', '2', '3', '4']);
  }
});

test('poster shows every hourly slot as available or booked instead of merging open ranges', async () => {
  const slots = Array.from({ length: 16 }, (_, index) => ({
    hour: 6 + index,
    end: 7 + index,
    state: index % 2 ? 'booked' : 'free',
  }));
  const snapshot = graphic.normalizeSnapshot({
    date: '2026-09-20',
    courts: [
      { id: '1', name: 'Court 1', slots },
      { id: '2', name: 'Court 2', slots },
    ],
  });
  const pages = graphic.paginateSnapshot(snapshot, 'feed');
  assert.equal(pages.length, 2);
  assert.ok(pages.every(page => page.courts.every(court => court.slots.length === 8)));
  const calls = [];
  for (let index = 0; index < pages.length; index += 1) {
    const canvas = fakeCanvas();
    await graphic.drawPoster(canvas, pages[index], 'feed', {
      logo: false,
      qr: false,
      pageNumber: index + 1,
      totalPages: pages.length,
      summarySnapshot: snapshot,
    });
    calls.push(...canvas.calls);
  }
  assert.equal(calls.filter(call => call.value === 'AVAILABLE').length, 16);
  assert.equal(calls.filter(call => call.value === 'BOOKED').length, 16);
  assert.ok(calls.some(call => call.value === '6–7 AM'));
  assert.ok(calls.some(call => call.value === '9–10 PM'));
});

test('feed and story draw one Court 3 card containing all three broken-time ranges', async () => {
  const snapshot = graphic.normalizeSnapshot({
    date: '2026-09-20',
    courts: [
      { id: '1', name: 'Court 1', slots: [{ hour: 8, end: 19, state: 'free' }, { hour: 23, end: 24, state: 'free' }] },
      { id: '2', name: 'Court 2', slots: [{ hour: 8, end: 19, state: 'free' }, { hour: 23, end: 24, state: 'free' }] },
      { id: '3', name: 'Court 3', slots: [
        { hour: 8, end: 15, state: 'free' },
        { hour: 18, end: 19, state: 'free' },
        { hour: 23, end: 24, state: 'free' },
      ] },
    ],
  });
  const pages = graphic.paginateSnapshot(snapshot, 'feed');
  assert.equal(pages.length, 1);
  assert.deepEqual(pages[0].courts.map(court => court.name), ['Court 1', 'Court 2', 'Court 3']);

  for (const format of ['feed', 'story']) {
    const canvas = fakeCanvas();
    await graphic.drawPoster(canvas, pages[0], format, { logo: false, qr: false });
    assert.equal(canvas.calls.filter(call => call.value === 'COURT 3').length, 1);
    ['8 AM–3 PM', '6–7 PM', '11 PM–12 AM'].forEach(label => {
      assert.ok(canvas.calls.some(call => call.value === label), `${format} must draw ${label}`);
    });
    assert.equal(canvas.calls.some(call => /(?:1\/2|2\/2)/.test(call.value)), false);
  }
});

test('carousel filenames are numbered and every rendered page carries its marker', async () => {
  const snapshot = graphic.normalizeSnapshot({
    date: '2026-09-20',
    courts: Array.from({ length: 9 }, (_, index) => ({
      id: String(index + 1),
      name: `Court ${index + 1}`,
      slots: [{ hour: 7, end: 8, state: 'free' }],
    })),
  });
  const pages = graphic.paginateSnapshot(snapshot, 'feed');
  for (let index = 0; index < pages.length; index += 1) {
    const canvas = fakeCanvas();
    await graphic.drawPoster(canvas, pages[index], 'feed', {
      logo: false,
      qr: false,
      pageNumber: index + 1,
      totalPages: pages.length,
      summarySnapshot: snapshot,
    });
    assert.deepEqual([canvas.width, canvas.height], [1080, 1350]);
    assert.ok(canvas.calls.some(call => call.value === `PAGE ${index + 1} / ${pages.length}`));
    assert.equal(
      graphic.outputFileName(snapshot.date, 'feed', index, pages.length),
      `pickle-street-availability-2026-09-20-feed-0${index + 1}-of-03.png`,
    );
  }
});

test('poster layouts keep branded content inside feed and story safe areas', () => {
  const feed = graphic.posterLayouts.feed;
  const story = graphic.posterLayouts.story;
  assert.ok(feed.footerContentBottom <= feed.safeBottom);
  assert.ok(story.brandY >= story.safeTop);
  assert.ok(story.footerContentBottom <= story.safeBottom);
  assert.ok(story.cardsEnd < story.footerY);
  assert.ok(story.brandY <= 120, 'story branding uses the upper canvas instead of leaving a large blank band');
  assert.ok(story.cardsEnd - story.cardsStart >= 800, 'story schedule expands into the available vertical space');
  assert.ok(graphic.formats.story.height - story.footerContentBottom <= 100, 'story footer uses the lower canvas without clipping');
});

test('footer keeps a large crisp QR and readable booking copy inside safe bounds', () => {
  assert.deepEqual(graphic.qrRenderConfig, {
    size: 231,
    margin: 4,
    errorCorrectionLevel: 'M',
    dark: '#050706',
    light: '#ffffff',
  });
  for (const format of ['feed', 'story']) {
    const poster = graphic.posterLayouts[format];
    const footer = graphic.footerLayouts[format];
    const cardRight = footer.qrCardX + footer.qrSize + footer.qrCardPadding * 2;
    const cardBottom = footer.qrCardY + footer.qrSize + footer.qrCardPadding * 2;
    assert.equal(footer.qrSize, 231);
    assert.ok(footer.qrCardX >= 72 && cardRight <= graphic.formats[format].width - 72);
    assert.ok(footer.qrCardY >= poster.footerY && cardBottom < footer.qrLabelY);
    assert.ok(footer.qrLabelY <= poster.footerContentBottom);
    assert.ok(footer.urlFontSize >= 48);
    assert.ok(footer.updatedFontSize >= 30);
    assert.ok(footer.qrLabelFontSize >= 20);
  }
  assert.ok(graphic.footerLayouts.story.qrLabelY <= graphic.posterLayouts.story.safeBottom);
  const source = fs.readFileSync(require.resolve('./availability-graphic.js'), 'utf8');
  assert.match(source, /qrCanvas\(bookingUrl, footer\.qrSize\)/);
  assert.match(source, /context\.imageSmoothingEnabled\s*=\s*false/);
  assert.match(source, /Updated \$\{formatGeneratedAt\(snapshot\.generatedAt\)/);
});

test('opening date and Web Share fallback are explicit', () => {
  assert.equal(graphic.constants.OPENING_DATE, '2026-09-19');
  assert.match(graphic.shareErrorMessage({ name: 'NotAllowedError' }), /Download PNG/);
  assert.match(graphic.shareErrorMessage({ name: 'NotAllowedError' }), /upload.*Facebook/i);
  assert.equal(graphic.shareErrorMessage({ name: 'AbortError' }), '');
});

test('every output path is guarded by a forced serialized live refresh', () => {
  const source = fs.readFileSync(require.resolve('./availability-graphic.js'), 'utf8');
  assert.match(source, /refresh\(\{ replace: false, force: true,/);
  assert.match(source, /if \(state\.outputPromise\) return state\.outputPromise/);
  assert.match(source, /const snapshot = await ensureFreshForExport\(label\);\s*setBusy\(true,/);
  assert.match(source, /const pages = paginateSnapshot\(snapshot, state\.format\)/);
  assert.match(source, /const \{ items \} = await prepareOutputSet\('download'\)/);
  assert.match(source, /await ensureFreshForExport\('caption copy'\)/);
  assert.match(source, /const \{ items, snapshot \} = await prepareOutputSet\('share'\)/);
  assert.match(source, /navigator\.share\(\{ title: 'Pickle Street court availability', text: caption, files \}\)/);
  assert.doesNotMatch(source, /if \(state\.busy\) return currentSnapshot\(\)/);
});

test('styles include the integration launch hook and responsive three-action layouts', () => {
  const css = fs.readFileSync('availability-graphic.css', 'utf8');
  assert.match(css, /\.availability-post-launch\s*\{/);
  assert.match(css, /grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(css, /\.prag-canvas-shell canvas[\s\S]*max-height:\s*100%/);
  assert.match(css, /body\.prag-modal-open\s*\{\s*overflow:\s*hidden/);
  assert.match(css, /@media \(max-width: 820px\)[\s\S]*?\.prag-workspace\s*\{[\s\S]*?display:\s*block;[\s\S]*?overflow-y:\s*auto;/);
  assert.match(css, /@media \(max-width: 820px\)[\s\S]*?\.prag-controls\s*\{[\s\S]*?min-height:\s*max-content;[\s\S]*?overflow:\s*visible;/);
});

test('production admin includes the live availability adapter and launch wiring', () => {
  const admin = fs.readFileSync('admin.html', 'utf8');
  const client = fs.readFileSync('supabase-config.js', 'utf8');
  assert.match(admin, /Availability Post/);
  assert.match(admin, /availability-graphic\.js/);
  assert.match(client, /async getAvailabilityGraphic\(date, courtIds = \[\]\)/);
  assert.match(client, /if \(PB_PLATFORM_V1\)[\s\S]*?_pbPlatformAvailability\(requestedDate\)/);
  assert.match(client, /_sb\.rpc\('get_admin_availability_graphic'/);
  assert.match(client, /async getAvailabilityGraphicSnapshot\(date, courtIds = \[\]\)/);
});
