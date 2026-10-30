# Merry Made Rank

Free Etsy keyword research, tag optimizer, title and tag builder, and fee calculator. It's a single static page hosted on GitHub Pages.

Live: https://abbasforpro.github.io/merry-made-rank/

Live keyword data comes from the official Etsy Open API v3 free tier and Google autocomplete. Your Etsy API key is saved only in your own browser's local storage and is never stored in this repository.

## Rank tracker

The Rank tracker tab shows where each of the shop's active listings ranks in Etsy search for its focus keywords: position, change since the last check, best position, and how many listings are on page 1, in the top 100 and in the top 300.

- `scripts/check-ranks.mjs` does the check. It reads the keywords in `data/rank-keywords.json` (a listing missing there is tracked on the start of its title), searches the top 300 results for each keyword through the Cloudflare connector, and appends the day's positions to `data/rank-history.csv`.
- `.github/workflows/rank-check.yml` runs it every day at 9:00 AM Pakistan time and commits the results. Run it any time from the Actions tab with Run workflow.
- Positions follow the Etsy API's relevance order (`sort_on=score`). It's close to Etsy search but leaves out ads and personal results.
