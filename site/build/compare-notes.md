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
- **LibreTorrent, speed limits = No, Wi-Fi only = No, plain links = No.** Not listed on its pages. Its README mentions "customisable network settings" without detail.
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
