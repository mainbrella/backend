# Five-size benchmark qualification

The first bounded live batch requested exactly 17 customer starts. All recorded generations were cleaned up. Account starts rose from 20 to 42, including five operator starts outside this batch; the operator confirmed those starts and paused further activity. Evidence is retained privately at `.wrangler/benchmark-sizes-20261006-complete/benchmark.json`, including the original three-sample batch. No p95, provider cold-cache or release-qualified claim is supported by these single samples.

Valid measurements below are seconds of public-API phase latency, including managed execution polling. Fresh guest workload directories were used; provider registry/image-cache placement is unknown.

| Size | Node startup | npm install | TypeScript build/test | pip install | Python build/numeric test |
| --- | ---: | ---: | ---: | ---: | ---: |
| Lite | 1.42 | 4.36 | 4.49 | 9.38 | Invalid fixture |
| Small | 1.04 | 4.20 | 4.09 | 9.03 | 2.69 |
| Medium | 0.96 | 4.01 | 2.51 | 9.20 | 2.40 |
| Large | 0.88 | 4.10 | 2.31 | 9.32 | 2.50 |
| XL | 0.90 | 4.03 | 2.58 | 7.47 | 2.34 |

Two simultaneous Small Node generations started in 0.90/1.19 seconds and completed combined npm installation/build/test in 7.49/7.56 seconds. This demonstrates that bounded two-generation sample; it is not a concurrency saturation benchmark.

Invalid measurements remain in the raw evidence. Browser apt installer progress exceeded the 1 MiB managed-output limit on Small–XL; Lite browser installation timed out. Rust lost PATH/RUSTUP_HOME under a login shell; Lite Rust had an ambiguous admission and no valid workload sample. Lite Python's generated fixture had a quoting bug. Corrected fixtures bound installer logs, explicitly set the Rust environment and preserve Python escapes. They require live replay before browser/Rust qualification.

The targeted replay requests at most eleven starts: Node/browser and Rust at each of five sizes, plus Lite Python. It does not repeat the two concurrent Small samples:

```
node scripts/benchmark-sizes.mjs --corrected=true --max-starts=11 --output=.wrangler/benchmark-corrected-<date>
```

Do not run without an approved budget. Keep account starts paused. Recovery keys precede admission, each generation has a ten-minute wall deadline, and cleanup failure stops the sequential matrix. Ambiguous starts require reconciliation with their original keys before continuing.

## Resource economics

Using published provider rates checked on 2026-10-06 UTC, gross container resources cost the following per running hour, before provider included allowances and all other services:

| Size | Idle allocated RAM/disk | Fully active allocated CPU + RAM/disk |
| --- | ---: | ---: |
| Lite | $0.002754 | $0.007254 |
| Small | $0.038016 | $0.074016 |
| Medium | $0.057024 | $0.129024 |
| Large | $0.076032 | $0.220032 |
| XL | $0.113040 | $0.401040 |

Rates: active CPU $0.000020/vCPU-second, provisioned memory $0.0000025/GiB-second, disk $0.00000007/GB-second. Source: [Cloudflare Containers pricing](https://developers.cloudflare.com/containers/platform/pricing/). These are estimates, not measured invoice amounts. Provider CPU is billed on activity while memory/disk remain provisioned.

XL has the highest saturated resource cost per Mainbrella compute unit. Fully using each plan's allowance at that size would cost approximately $3.58/$128.91/$716.14 in gross resources for Builder/Pro/Scale. At current plan prices, $1.42/$51.09/$282.86 remain before egress, Workers, Durable Objects, D1, logs, builds, registry, snapshots and support. Included provider allowances are also excluded. This does not establish overall profitability; snapshot economics and a wider saturation sample remain unmeasured.
