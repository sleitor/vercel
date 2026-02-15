import { afterAll } from 'vitest';
import childProcess from 'node:child_process';

const realOpenCalls: string[] = [];
const origSpawn = childProcess.spawn;
childProcess.spawn = function (...args: any[]) {
  if (String(args[0]) === 'open') {
    realOpenCalls.push(String(args[1]?.[0] ?? ''));
    console.error(`\n🚨 REAL OPEN: ${args[1]}\n`);
  }
  return origSpawn.apply(childProcess, args as any);
} as typeof childProcess.spawn;
Object.assign(childProcess.spawn, origSpawn);

afterAll(() => {
  childProcess.spawn = origSpawn;
  if (realOpenCalls.length > 0) {
    console.error(`\n=== ${realOpenCalls.length} REAL OPEN CALLS ===`);
    realOpenCalls.forEach(u => console.error(`  ${u}`));
  } else {
    console.error('\n✅ No real open calls.');
  }
});
