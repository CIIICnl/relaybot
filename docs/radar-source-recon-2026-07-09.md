# Radar signals — bron-recon (feed-realiteit) v1

Recon: 2026-07-09, ciiic-automator kant van briefing
`from-monitor--to-ciiic-automator--radar-signals-ingest`. Doel: per v1-allowlist-bron
de **praktische scan-methode** vaststellen (live geprobed), zodat het ingest-ontwerp
en de relevantie-drempel kloppen. Item 3 van "What I need back".

## Kernconclusie

De briefing/het researchrapport markeren 4 van de 5 bronnen als "nieuwsbrief/LLM-scan".
**Dat is te pessimistisch: 3 van de 5 zijn machine-readable** (API/CSV/RSS). Alleen 2
vergen echt HTML-scrape of nieuwsbrief. Dat verandert het ontwerp gunstig: minder
fragiele LLM-scans, meer gestructureerde pulls.

## Per bron

| Sleutel | Bron | Beste methode (geprobed) | Status | Notities |
|---|---|---|---|---|
| `xrmust` | XRMust XR Agenda | **WP REST API** `GET /wp-json/wp/v2/all-events` | ✅ groen | `x-wp-total: 4600`. Custom post types `all-events` + `all-experiences`, elk paginated + eigen sitemaps. Ook `/feed`, `/rss`, `/sitemap_index.xml` = 200. **Niet** nieuwsbrief-only. |
| `immersive-filmmaking-sheet` | Google Sheet (Molodtsov) | **CSV-export** `…/export?format=csv` | ✅ groen | Publiek, 200, ~16 KB. Header-rij is rommelig ("XR FILM FESTIVALS CALENDAR 2026,,,,"); multi-tab (per `gid` aparte export). Parsen met kop-detectie of LLM. |
| `immersive-wire` | Immersive Wire (Tom Ffiske) | **beehiiv RSS** `/rss-feed` + `/archive` | ✅ groen | Platform = beehiiv; sitemap noemt `/rss-feed` en `/archive`. LLM-extract van events uit de issue-body. Geen `/rss` of `/feed` (die gaven 404) — het is `/rss-feed`. |
| `immersievekunstagenda` | Immersievekunstagenda.nl | **HTML-scrape** (SSR) → LLM | 🟡 geel | Geen feed/sitemap/robots (alles 404). Homepage is SSR-HTML (~136 KB) mét agenda-inhoud (24× "agenda", exposities/installaties). Scrape-baar, maar structuur is redactioneel → LLM-extractie. |
| `clicknl` | CLICKNL agenda | onduidelijk — `/events/` bestaat, listing niet in statische HTML | 🔴 rood | `/events/` = 200 en `sitemap.xml` = 200, maar de HTML bevat geen event-listing/datums (JS-gehydreerd of sparse). Geen feed. Vergt headless-render of nieuwsbrief-ingest. Laagste signaal van de vijf. |

## Implicaties voor het ingest-ontwerp

1. **XRMust incrementeel, niet volledig.** 4600 events; niet elke dag alles pullen.
   Gebruik `?orderby=modified&order=desc` en stop zodra je onder de vorige-run-watermark
   komt (bewaar `last_modified` in de lokale `better-sqlite3` seen-store). De WP `date`/
   `modified`-velden zijn post-datums; de **event-datum** zit niet als los veld in de
   list-response (velden: `id, date, modified, slug, title, link, event-key, meta, class_list`)
   → per event de detailpagina/`meta` ophalen of uit titel/content extraheren. Test welke
   `meta`-sleutel de event-datum bevat vóór je hierop bouwt.
2. **CSV & RSS zijn "gratis" structuur** — begin de pijplijn met xrmust + sheet + immersive-wire;
   die drie geven al brede dekking zonder scrape-fragiliteit.
3. **CLICKNL** is de twijfelbron. Voorstel: v1 op laag pitje (of uit de default-drempel),
   heroverwegen of het een headless-render (Playwright is al in de workspace) of
   nieuwsbrief-ingest waard is. Weinig unieke immersive-signalen verwacht t.o.v. de rest.
4. **Nieuwsbrief-ingest als bestaande kracht.** De relay ontvangt al e-mail op
   `*@bot.ciiic.nl`. Voor genuine nieuwsbrief-bronnen (of CLICKNL/immersievekunstagenda als
   scrape tegenvalt) is "abonneer de nieuwsbrief op een relay-adres + LLM-scan de inbound mail"
   een natuurlijker mechanisme dan scrapen. Overwegen bij het contract met monitor.

## Voorstel allowlist-herijking (aan monitor terug te koppelen)

- `xrmust` → methode **API**, niet nieuwsbrief.
- `immersive-wire` → methode **RSS** (`/rss-feed`), niet los nieuwsbrief-scrape.
- `immersive-filmmaking-sheet` → **CSV** (ongewijzigd, bevestigd werkend).
- `immersievekunstagenda` → **HTML-scrape**, blijft LLM.
- `clicknl` → **onzeker**; degraderen of via nieuwsbrief/headless.

## Nog te doen (na dit recon-moment)

- Exact payload-contract + `dedup_key`-normalisatie + secret-naam afstemmen met de
  monitor-agent (endpoint `/api/radar/ingest` bestaat nog niet).
- XRMust: uitzoeken welk `meta`-veld de event-datum draagt.
- Sheet: de relevante tab(s)/`gid` vaststellen (nu alleen de eerste tab geëxporteerd).
