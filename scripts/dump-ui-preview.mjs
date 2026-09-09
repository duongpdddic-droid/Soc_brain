#!/usr/bin/env node
// dump-ui-preview.mjs — write the rendered UI v1 page to a temp HTML file for
// visual smoke (open in a browser, no server needed). Read-only on the repo.
import fs from 'node:fs';
import path from 'node:path';
import { renderUiPage } from '../packages/control-ui/control-ui.mjs';

const out = process.argv[2] || path.join(process.env.TEMP || '.', 'soc-brain-ui-v1-preview.html');
fs.writeFileSync(out, renderUiPage(), 'utf8');
console.log(`[preview] ${out}`);
