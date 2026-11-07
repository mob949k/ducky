# Changelog

## 3.5
- Redesigned popup: illustrated header, bigger controls and clearer buttons.
- New **Pin** button: use one volume on every site, and go back to per-site volumes anytime.
- New **Settings** page: see and forget saved sites, turn off the pin, change shortcuts.
- "Reload the page" notice now has a button that reloads the tab for you.
- Keyboard shortcuts follow the pin when it's on.

## 3.4
- The whole interface is now in English.
- Stricter security policy for the popup (no inline code, no plugins).
- The popup's level meter pauses when the popup is hidden.
- Saved settings are range-checked before use, even if they get corrupted.
- New repository layout: the extension lives in `extension/`, and every version is published as a ready-to-install `ducky.zip`.

## 3.3
- Cross-site videos are boosted without sending your cookies, so a page can't use Ducky to read private content from another site.
- Sites on the internet can never get access to your local network (router, cameras, NAS, localhost).
- Temporary permissions are capped per tab and removed when you close the tab or move to another site.
- Muted previews (hover-to-play thumbnails, silent ads) are ignored until they make sound.
- The level meter only uses CPU while the popup is open; frames without audio run no timers.

## 3.2
- Boosts players that load after the page opens, including embedded players from video services.
- Boosts videos served from another domain or CDN.
- Detects players inside web components (shadow DOM), `new Audio()` players and players that use Web Audio.

## 3.1
- New interface: duck footprint pattern, larger controls, less text.

## 3.0
- Fixed the errors that piled up after long sessions.
- Shared audio chain per frame instead of one per video; idle audio sleeps.
- Embedded players follow the volume of the site you're on.
