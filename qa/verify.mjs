// Quick live-verify CLI: launch the built app, open real data, go to a tab,
// screenshot it, and report errors. For ad-hoc visual checks without writing a
// full driver each time.
//
//   node qa/verify.mjs trace            # open SEG-Y, screenshot the Trace Inspector
//   node qa/verify.mjs sps              # load the SPS triplet, screenshot the SPS tab
//   node qa/verify.mjs workbench        # open SEG-Y, screenshot the Workbench
//   node qa/verify.mjs spectrum --shot=spec
//
// Tabs: conv trace section sps vel spectrum workbench obslog
import { launch, openFile, loadSps, gotoTab, shot, SEGY, sleep } from './harness.mjs';

const TABS = {
  conv: ['tab-conv', 'panel-conv'], trace: ['tab-trace', 'panel-trace'], section: ['tab-section', 'panel-section'],
  sps: ['tab-sps', 'panel-sps'], vel: ['tab-vel', 'panel-vel'], spectrum: ['tab-spectrum', 'panel-spectrum'],
  workbench: ['tab-workbench', 'panel-workbench'], obslog: ['tab-obslog', 'panel-obslog'],
};
const tab = (process.argv[2] || 'trace').toLowerCase();
const shotArg = (process.argv.find((a) => a.startsWith('--shot=')) || '').split('=')[1];
if (!TABS[tab]) { console.error(`unknown tab "${tab}". one of: ${Object.keys(TABS).join(' ')}`); process.exit(2); }

const { app, win, errors } = await launch();
try {
  if (tab === 'sps') {
    await loadSps(app, win);
  } else {
    const n = await openFile(app, win, SEGY);
    console.log(`opened SEG-Y → traces=${n}`);
  }
  await gotoTab(win, TABS[tab][0], TABS[tab][1]);
  await sleep(600);
  const path = await shot(win, shotArg || `verify-${tab}`);
  console.log(`screenshot: ${path}`);
  console.log('errors: ' + (errors.length ? JSON.stringify(errors) : 'none'));
} finally {
  await app.close();
}
process.exit(errors.length ? 1 : 0);
