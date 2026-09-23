import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';
import { parseMinor, toAmount, toEditString, fromAmount, setMoneyFormat } from '../../../client/src/lib/money.ts';

// Execute the actual local preview helpers with a fixed browser date.
const source = readFileSync(new URL('../../../client/src/pages/JarsPage.tsx', import.meta.url), 'utf8');
const helpers = source.slice(source.indexOf('function monthsFromNow'), source.indexOf('interface FormState'));
class FixedDate extends Date {
  constructor(...args) { super(...(args.length ? args : [2026, 8, 22, 12])); }
}
const context = vm.createContext({ Date: FixedDate, JarKind: { Recurring: 0, Goal: 1 } });
vm.runInContext(stripTypeScriptTypes(helpers), context);
console.log('Recurring preview due Sep 1, as of Sep 22:', vm.runInContext('1200 / Math.max(1, monthsToEffectiveDue("2026-09-01", 0, 12))', context));
console.log('Preview effective date:', vm.runInContext('effectiveDueIso("2026-09-01", 0, 12)', context));
console.log('Jan 31 monthly recurrence displayed date:', vm.runInContext('effectiveDueIso("2026-01-31", 0, 1)', context));
setMoneyFormat('dot-comma');
const editText = toEditString(fromAmount(1.234));
console.log('Comma-decimal edit roundtrip:', { original: 1.234, editText, parsed: toAmount(parseMinor(editText)) });
