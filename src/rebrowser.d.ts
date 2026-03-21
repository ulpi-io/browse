/**
 * rebrowser-playwright is a drop-in fork of playwright with stealth patches.
 * Re-export playwright's types so tsc passes without the package installed.
 */
declare module 'rebrowser-playwright' {
  export * from 'playwright';
}
