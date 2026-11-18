# Comparison notes (checked 2026-11-12)

## Apps and URLs used

All ten apps had a reachable official page, so none were dropped.

- **Maglev**: https://github.com/Kaos599/Maglev (README and site/build/content.json only)
- **LibreTorrent**: https://github.com/proninyaroslav/libretorrent (the URL https://github.com/LibreTorrent/LibreTorrent returned 404); https://f-droid.org/packages/org.proninyaroslav.libretorrent/
- **BiglyBT (Android)**: https://www.biglybt.com/ (desktop site, ad-free and news only); https://github.com/BiglySoftware/BiglyBT-Android; https://f-droid.org/en/packages/com.biglybt.android.client/; https://play.google.com/store/apps/details?id=com.biglybt.android.client&hl=en_US
- **Seal**: https://github.com/JunkFood02/Seal (README); https://github.com/JunkFood02/Seal/blob/main/README.md; https://f-droid.org/packages/com.junkfood.seal/
- **YTDLnis**: https://github.com/deniscerri/ytdlnis (README); https://github.com/deniscerri/ytdlnis/blob/main/README.md; https://f-droid.org/packages/com.deniscerri.ytdl/
- **NewPipe**: https://newpipe.net/; https://github.com/TeamNewPipe/NewPipe; https://f-droid.org/packages/org.schabi.newpipe/
- **Flud**: https://play.google.com/store/apps/details?id=com.delphicoder.flud&hl=en_US
- **1DM+** (formerly IDM+; the listing for 1DM): https://play.google.com/store/apps/details?id=idm.internet.download.manager.plus&hl=en
- **ADM (Advanced Download Manager)**: https://play.google.com/store/apps/details?id=com.dv.adm&hl=en_US
- **FDM (Free Download Manager)**: https://play.google.com/store/apps/details?id=org.freedownloadmanager.fdm&hl=en_US; https://www.freedownloadmanager.org/download.htm (FDM for Android is listed there and on Play)

Not used: the Uptodown, Aptoide, AppBrain and similar mirror pages that turned up in search. The 1DM+ Play page was reached through a search result; its Play ID is the official one.

## Deviations from the brief

- **Row labels (revised 2026-11-13).** Ads, in-app purchases and account rows now read "No ads", "No in-app purchases" and "No account needed", so Yes is always the good answer. Yes needs a source: an explicit "ad free", or a store listing with no Ads, Tracking or in-app purchases label. Flud and ADM carry the Contains ads label.
- **Version row** uses text ("Android 7", "Not listed") as the brief allows.
- **Closed or open source:** the brief groups Flud, 1DM+, ADM and FDM as closed source. Their pages do not state a license, so "No" is a "not listed" value.

## Uncertain or judgment-call cells

- **Maglev, "Needs an account" = No.** The README and content.json do not say this. The value is from the brief (sign-in: none needed). Confirm before publishing.
- **Maglev, "Minimum Android version" = Android 7.** From the README badge and content.json FAQ.
- **LibreTorrent, background downloads = No.** Its pages do not describe background downloads or notifications, though it lists a foreground-service permission on F-Droid. Marked No because the pages do not state it.
- **LibreTorrent, speed limits = Yes, Wi-Fi only = Yes (checked 2026-11-14).** Its source strings list "Max. ⬇ speed", "Max. ⬆ speed" and "Only use connections without a quota (for example Wi-Fi or Ethernet)": https://github.com/proninyaroslav/libretorrent/blob/master/app/src/main/res/values/strings.xml. **Plain links = No:** not listed on its pages.
- **BiglyBT, magnet links = No.** The Android pages do not mention magnets; the desktop project does. Worth a second look, since a torrent client almost certainly supports magnets.
- **BiglyBT, free = Partial.** No price is shown; the Play listing has in-app purchases.
- **BiglyBT, minimum Android = 4.1.** From the F-Droid build (version 1.3.4.3). The Play listing did not show a version.
- **Seal and YTDLnis, YouTube = Partial.** Their pages say "sites supported by yt-dlp" and "1000+ websites" without naming YouTube. Also, Seal and YTDLnis HLS = No, as not named on the pages.
- **YTDLnis, built-in browser = Partial.** The browser is used for logging in to get cookies, not for general browsing.
- **YTDLnis, RSS = Partial.** It watches playlists and channels for new uploads, which is not described as RSS.
- **YTDLnis, background downloads = Partial.** Live notifications are listed; background runs are described only through intents.
- **NewPipe, contains ads = No.** The page says "without annoying ads", not "ad free".
- **NewPipe, minimum Android = 6.** From the F-Droid listing.
- **Seal, minimum Android = 5.** From the F-Droid listing.
- **1DM+, HLS = Partial.** The Play page says it "supports HTTP Live Streaming websites". DASH and AES-128 are not mentioned.
- **1DM+, pause and resume = Partial.** The page says pause and resume work "with supported links".
- **1DM+, price = Partial.** The Play page does not state a price.
- **1DM+, speed limits = Yes.** The page lists a speed limiter.
- **1DM+, file selection in torrents = No.** The page does not mention it.
- **1DM+, "contains ads" = No.** The page says "Ad free".
- **ADM, finds files on a page = Partial.** It has an "advanced media downloader" and a "video downloader". The page does not say how it finds files.
- **ADM, price = Partial.** No price on the page; the Play listing says it contains ads and in-app purchases.
- **ADM, ad blocking = No.** Reviews mention a pop-up blocker; the official page does not.
- **FDM, browser = No.** The developer's Play reply says it is primarily a download manager, not a browser.
- **FDM, finds files on a page = No.** The video add-on is listed for desktop browsers only.
- **FDM, speed limits = Partial.** The page says it "adjusts traffic usage", not a speed cap.
- **FDM, price = Partial.** No price on the page.
- **FDM, YouTube = No.** The Play page says YouTube downloads are not supported.
- **Flud, speed limits = No.** The Play page says "No speed limits on downloads/uploads", which is the reverse of a limit. The row is marked No, and the note explains it.
- **Flud, play while downloading = Partial.** It lists sequential downloads, not streaming.
- **Flud, price = Partial.** The Play page says "Contains ads" and in-app purchases; no price.
- **Flud and ADM, "Contains ads" = Yes**, from their Play pages.
- **Flud, ADM, 1DM+ and FDM, "Open source" = No.** Not listed. Their pages do not say they are closed source either.
- **Flud, 1DM+, ADM and FDM, minimum Android.** Not listed on the Play pages that were read.
- **Maglev, live streams = No, YouTube = No.** From the README.

## Fetch errors seen

- https://github.com/LibreTorrent/LibreTorrent returned 404; the working repo is proninyaroslav/libretorrent.
- https://www.1dm.app/ returned invalid_url; not used.
- Guessed Play IDs for a separate ADM-style 1DM listing (idm.internetdownloadmanager) and FDM (com.fdmandroid) returned 404; not used.
- https://biglybt.com/android and https://github.com/BiglyBT/BiglyBT returned 404; not used.

## Rows added 2026-11-13

Maglev evidence is the README and the code: merged results and fake-upload warnings (utils/search/aggregate.ts, utils/search/safety.ts), Jackett or Prowlarr (components/search-providers/TorznabSheet.tsx), follow a show (components/search/FollowSheet.tsx), open folder (components/transfers/DownloadSheet.tsx), mobile data note (utils/addChecks.ts, components/search/MobileDataSheet.tsx), VPN only (app/settings/network.tsx), battery and charging (app/settings/power.tsx), Quick Settings tile (modules/maglev-engine/android MaglevTileService), themes (app/settings/interface.tsx). No analytics SDK appears in package.json or app.json.

Competitor sources: Play pages for Flud, 1DM+, ADM, FDM and BiglyBT (read through a text extractor because the plain fetch returned empty pages), F-Droid listings for LibreTorrent, BiglyBT, Seal, YTDLnis and NewPipe, and the READMEs. Rows with Maglev-only Yes (search merging, warnings, indexers, follow, VPN, tile, mobile-data prompt) have no competitor page that lists the feature.

- **No analytics or tracking:** Yes for F-Droid apps with no Tracking anti-feature and FDM ("No data collected" on Play). BiglyBT has the Tracking anti-feature. Flud, 1DM+ and ADM declare collection or sharing in Play data safety.
- **No ads and No in-app purchases:** Yes where the page says ad free, or where the store listing has no Contains ads or In-app purchases label. This is a looser reading than "must be listed", because a label the store requires is absent. Check again if a store adds a label.
- **Pauses on low battery:** ADM Yes (its page lists autostop on low battery). LibreTorrent Partial (lists "battery settings" without detail).
- **Dark and light themes:** Seal and YTDLnis Partial (theming named, dark or light not).
- **No account needed:** Yes for every app, as before (no page mentions a sign-in requirement). Maglev's value still comes from the brief and the app having no sign-in step.

## Alternative pages (added with the one-page-per-app pages)

Pages: `1dm-alternative`, `adm-alternative`, `libretorrent-alternative`, `flud-alternative`. Their claims about other apps reuse the sources and dates above (checked 2026-11-12 and 2026-11-13); no new fetches were made for them. Each page's "When X is the better choice" section names only what the sources list: Google Play installs and updates for 1DM+, ADM and Flud, F-Droid for LibreTorrent, ADM's home-screen widget, LibreTorrent's own F-Droid description, and Flud's speed-limit wording. Points that depend on a page not listing a feature are phrased as "does not list" and match the "Not listed counts as No" rule.

Not built: BiglyBT and FDM pages (no separate search demand was checked, and the hub table already covers them). Stremio and Nuvio left out on purpose. YouTube downloaders are covered by one paragraph on the compare page, not by their own pages.

## Subtitles row (added 2026-11-18, for 0.30)

Row `subtitles`, "Finds subtitles for saved videos": the app looks up subtitle files for a video you already have and saves one next to it. Embedding the subtitles a video's own site offers while downloading is a different job, so it does not count.

Maglev evidence: `utils/subtitles/providers/` (21 sources), `utils/subtitles/naming.ts`, `release-notes/0.30.md`. Competitor cells follow the table's rule: a feature the app's own pages do not list is No. Pages read on 2026-11-18, searched for "subtitle" and "caption":

- **LibreTorrent**, No: README https://raw.githubusercontent.com/proninyaroslav/libretorrent/master/README.md and F-Droid https://f-droid.org/packages/org.proninyaroslav.libretorrent/ list none. Its source (https://github.com/proninyaroslav/libretorrent) was not searched.
- **BiglyBT**, No: Play description (full text, https://play.google.com/store/apps/details?id=com.biglybt.android.client&hl=en&gl=US) and F-Droid https://f-droid.org/en/packages/com.biglybt.android.client/ list none.
- **Seal**, No: README https://raw.githubusercontent.com/JunkFood02/Seal/main/README.md lists "Embed subtitles into the downloaded videos" (the video site's own subtitles), not a search of subtitle sites.
- **YTDLnis**, No: README https://raw.githubusercontent.com/deniscerri/ytdlnis/main/README.md lists embedding and burning in subtitles, same reading as Seal.
- **NewPipe**, No: the F-Droid page https://f-droid.org/packages/org.schabi.newpipe/ lists none; the README fetch returned no body text.
- **Flud**, No: Play description (full text, https://play.google.com/store/apps/details?id=com.delphicoder.flud&hl=en&gl=US) lists none.
- **1DM+**, Not listed (shown as No): the Play page (https://play.google.com/store/apps/details?id=idm.internet.download.manager.plus&hl=en) returned only excerpts, ranked by "subtitles", and none mentioned them. The full description did not load, so this is unconfirmed.
- **ADM**, No: Play description (full text, https://play.google.com/store/apps/details?id=com.dv.adm&hl=en&gl=US) lists none.
- **FDM**, No: Play description excerpts (https://play.google.com/store/apps/details?id=org.freedownloadmanager.fdm&hl=en_US) list none. Excerpts only.

`checkedOn` at the top of compare.json is unchanged; only this row was checked on 2026-11-18.

## Backup, size filter and mining/HTTPS rows (added 2026-11-18, for 0.30)

Rows `backup` (Control), `search-size-filter` (Torrents) and `mining-https` (Browser and streams, after pop-up control). Same rule as the subtitles row: a feature the app's own pages do not list is No. Partial means the page lists a narrower version. Pages read on 2026-11-18. The Play pages were read in full ("About this app" text), not as excerpts.

Maglev evidence: `utils/backup/format.ts` and `export.ts` (parts: settings, search sources, feeds, schedule, assistant, torrents, downloads; the assistant key reference is stripped; stats are an optional tick in `app/settings/backup.tsx`), `components/search/sizeRange.ts` (slider stops 50 MB to 64 GB, no minimum, no maximum), `utils/browser/hardening.ts` (`upgradeToHttps` with fall back) and `modules/maglev-engine/android/.../BlocklistStore.kt` (`miners.txt` merged into every active list), `release-notes/0.30.md`.

Backup and restore:
- **LibreTorrent**, Partial: strings.xml https://raw.githubusercontent.com/proninyaroslav/libretorrent/master/app/src/main/res/values/strings.xml has "Save backup", "Restore backup", "Channels saved" (RSS channels only). README https://raw.githubusercontent.com/proninyaroslav/libretorrent/master/README.md and F-Droid https://f-droid.org/packages/org.proninyaroslav.libretorrent/ list no backup.
- **BiglyBT**, No: Play description (full text, https://play.google.com/store/apps/details?id=com.biglybt.android.client&hl=en&gl=US) and F-Droid https://f-droid.org/en/packages/com.biglybt.android.client/ list none.
- **Seal**, No: README https://raw.githubusercontent.com/JunkFood02/Seal/main/README.md lists none.
- **YTDLnis**, Yes: README https://raw.githubusercontent.com/deniscerri/ytdlnis/main/README.md, "Backup and restore almost everything, right from the welcome screen too".
- **NewPipe**, Partial: README https://github.com/TeamNewPipe/NewPipe says to use Settings > Backup and Restore > Export Database "so you keep your history, subscriptions, and playlists". Settings are not named.
- **Flud**, No: Play description (full text, https://play.google.com/store/apps/details?id=com.delphicoder.flud&hl=en&gl=US) lists none.
- **1DM+**, Partial: Play description (full text, https://play.google.com/store/apps/details?id=idm.internet.download.manager.plus&hl=en) lists "Import download links from a text file" and "Export download links" only.
- **ADM**, Yes: Play description (full text, https://play.google.com/store/apps/details?id=com.dv.adm&hl=en&gl=US), "backup list of downloads and settings".
- **FDM**, No: Play description (full text, https://play.google.com/store/apps/details?id=org.freedownloadmanager.fdm&hl=en_US) lists none.

Filter search results by size: only Maglev lists a size filter on search results. Apps with no search of their own (LibreTorrent, Flud, 1DM+, FDM, Seal, YTDLnis) are No, the same way the torrent-search row treats them. BiglyBT (Play page) filters the files inside a torrent, and ADM (Play page) searches and sorts the files inside a torrent; neither is a search-result filter. NewPipe (README) searches videos and playlists and lists no size filter. YTDLnis README lists feeding search queries from a text file, no size filter.

Blocks crypto-mining scripts and upgrades to HTTPS: only 1DM+ and ADM have a general browser. Their full Play descriptions (URLs above) list an adblock browser, tabs, history, bookmarks and a media downloader, and mention neither mining scripts nor HTTPS. Seal and YTDLnis use a browser only to sign in for cookies (README) and FDM says it is not a browser (existing note), so all three are No. LibreTorrent, BiglyBT, NewPipe and Flud pages list no browser. This is "not listed", not a statement that the app does not do it.

`checkedOn` at the top of compare.json is unchanged; only these rows were checked on 2026-11-18. A fourth candidate row, "says why a download is paused", was dropped by the owner and is not in the table.
