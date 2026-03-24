import '../config/load-env.js';

import { resolveX402ServiceTarget } from '../config/x402-service.js';

const samples = [
  { label: 'missing', value: '' },
  { label: 'contract', value: '0x00000000000000000000000000000000000000aa' },
  { label: 'url', value: 'https://x402.example.com/pay' },
  { label: 'invalid', value: 'not-a-target' },
];

console.log(
  JSON.stringify(
    {
      action: 'validate_x402_service_target',
      results: samples.map((sample) => ({
        label: sample.label,
        input: sample.value,
        resolved: resolveX402ServiceTarget(sample.value),
      })),
    },
    null,
    2,
  ),
);
