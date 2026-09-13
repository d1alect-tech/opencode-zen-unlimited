# Ticket #3: dotochno 200-300 RUB/mo do ~15 egress — sub vs DC-pool

> Branch: `research/top-up-buy`. Prices volatile — **re-verify-at-buy-time**.
> Course Sep 2026: CBR 84.35 RUB/USD (11.09.2026), market ~86.6–87.3 (early Sep).
> Math below at **~85 RUB/USD**; ranges shown. No purchase links with tokens.
> Stack: `add-sub` = hy2/vless/trojan/ss (native outbounds); `add-proxy` = http/https/socks only;
> xhttp nodes drop on sing-box 1.14; target geo NL/DE/FI/PL/SE. Out of scope: VPS fleet,
> residential/mobile, WireGuard-only, IPv6-only.

## Options (Sep 2026)

| # | Option | Price Sep 2026 | In RUB (~85) | Protocols / links | Target-geo nodes | Cap | Shared? |
|---|--------|----------------|--------------|-------------------|------------------|-----|---------|
| A | Airport sub, budget tier (e.g. Twilight-class, $3/mo) | $3.00/mo | ~253–262 RUB | hy2 + vless (+trojan/ss), sing-box JSON + clash-meta links | ask: 50+ total, count per NL/DE/FI/PL/SE **excluding xhttp** | ~1 TB/mo | shared |
| B | Airport sub, mid tier (e.g. ClearNode-class, $3.47/mo) | $3.47/mo | ~293–303 RUB | vless+reality / xhttp / hy2 | same question; EU list incl. NL/DE/FI/PL/SE, but xhttp share drops on 1.14 | 500 GB–2 TB by tariff | shared |
| C | Webshare shared DC 100-pack | $2.99/mo (100 IPs, ~$0.03/IP) | ~252–261 RUB | **http/socks only > only via `add-proxy`** | geo-targeting limited, ASN concentration (DC ranges) | 250 GB incl. | shared, burned risk |
| D | Decodo DC pay-per-IP (100 IPs) / pay-per-GB | ~$0.035/IP (~$3.50) / $6 for 10 GB | ~298–306 RUB / ~510+ RUB | **http/socks only > only via `add-proxy`** | 14 countries shared pool; ASN concentration | per plan | shared |
| E | Buy nothing | $0 | 0 RUB | — (stopgap: Webshare free 10 IPs + 1 GB, no card) | free tier geo limited (4 countries) | 1 GB | shared, flagged fast |

Notes: airport $2–5/mo band per 2026 guides (Throughwire, ClashSource/ClashEnglish buying guides);
Lunaire-type tiers $3/1TB, $5/5TB (over budget), free 1 GB/day; ClearNode-type $3.47/mo 500GB–2TB, EU+US list.
Webshare entry $2.99/100 shared ($0.03/IP, down to ~$0.018 at volume); Decodo shared from ~$0.035/IP at 100 IPs
(~$0.02 at volume), pay-per-GB from $0.60/GB — the $6/10GB entry already breaks the budget.
DC pools never become sing-box tunnel outbounds — secondary `EGRESS_UPSTREAMS` only.

## Recommendation

- **Primary: option A — one more airport sub from a DIFFERENT seller/ASN (~255 RUB/mo).**
  Why: native hy2/vless outbounds via `add-sub` (fits min-ops: one sub link, `--name t3`),
  50+ nodes add fresh IPs/ASNs next to the 2 current subs > closes ~15 working egress;
  1 TB cap covers Zen traffic; stays inside 200–300 RUB. Take monthly only, with trial first.
- **Fallback: option C — Webshare 100-pack (~254 RUB/mo) ONLY as secondary via `add-proxy`.**
  Why fallback, not primary: http/socks only, ASN concentration, shared DC ranges burn fast on
  protected targets — it widens the pool but does not replace tunnel egress. Do NOT stack A+C
  at once (~510 RUB > budget): either A or C.
- **Verdict on E (buy nothing):** does not close ~15 — one IP burns in 1–1.5h today; free 10 IPs
  only as a probe before spending. If both A-trial and C-trial fail peak-hour tests, buy nothing
  and re-measure (ticket #2) instead of forcing a bad purchase.

Budget math (each option alone): A ? 3 ? 85 ? **255 RUB ? 300**; C ? 2.99 ? 85 ? **254 RUB ? 300**;
B ? 3.47 ? 85 ? **295 RUB** (borderline, over on market rate — ask for discount/monthly);
D-GB ? 6 ? 85 ? **510 RUB > budget, excluded**. A + C together ? 510 RUB — over budget, pick one.

## Exact questions to seller (paste as-is)

1. `sing-box JSON + clash-meta sub links? (need BOTH formats, native sing-box, not clash-only)`
2. `How many nodes in NL / DE / FI / PL / SE EXCLUDING xhttp? (xhttp drops on sing-box 1.14 — need 50+ usable hy2/vless)`
3. `Monthly traffic cap + multiplier? (x1.0? any x2–x3 nodes in EU?)`
4. `Shared or dedicated IPs/ports? Which ASN(s)? Different from typical budget sellers?`
5. `Trial (1 day / 1 GB) + peak-hour (20:00–23:00) test allowed? Refund inside 24h?`

## Min-ops wiring (after buy)

```powershell
$env:SUB_URL = "<fill via env>"
bun run src/index.ts add-sub $env:SUB_URL --name t3
bun run src/index.ts doctor
```

## Sources (accessed 13.09.2026)

- https://www.webshare.io/proxy-server (100 proxies $2.99/mo; 10 free)
- https://decodo.com/proxies/datacenter-proxies/pricing (from $0.60/GB; from ~$0.035/IP at 100)
- https://decodo.com/blog/best-datacenter-proxies (Webshare 100 for $2.99/mo; Decodo shared from $6/10GB)
- https://lunaire.app/en/hysteria ($3/mo 1TB / $5/mo 5TB / free 1GB-day; hy2+vless+xhttp+ws in one sub)
- https://wmcentre.su/en/item/clearnodevpn-happ-v2raytun-vless-reality-xhttp-hysteria2-rf-i-mir-ot1-mesyatsa-5882125 ($3.47/mo, EU list, 500GB–2TB)
- https://www.throughwire.net/blog/china-airport-providers (airport $2–5/mo band, 2026-05-27)
- https://clashsource.com/en/blog/articles/how-to-choose-airport-subscription-clash-guide-2026.html (trial/peak-hour/node-inflation checks)
- https://www.cbr.ru/eng/currency_base/daily/ (USD 84.3508, set 11.09.2026)
- https://www.exchangerates.org.uk/USD-RUB-exchange-rate-history.html (~86.6–87.3 early Sep 2026)
