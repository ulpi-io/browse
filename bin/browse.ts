#!/usr/bin/env tsx
import { main } from '../src/cli';

if (process.env.__BROWSE_SERVER_MODE === '1') {
  import('../src/server');
} else {
  main().catch((err) => {
    console.error(`[browse] ${err.message}`);
    process.exit(1);
  });
}
