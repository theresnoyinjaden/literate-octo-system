# Seed designs for 52-0

These four files are faithful static snapshots of the four screens in
`game/index.html` (`52-0 — Draft the Perfect #1`), extracted so the
Superdesign MCP tools have something concrete to iterate on:

- `home_1.html` — title screen
- `roll_1.html` — era + genre dual-reel roll (shown 6x per playthrough)
- `assign_1.html` — artist → stat-category drafting screen (the core decision point)
- `result_1.html` — end-of-run scorecard

Each file has an HTML comment at the top of `<div id="root">` naming a
concrete, screenshot-verified UX gap in that screen. Use `superdesign_iterate`
on any of them, e.g.:

> Iterate on assign_1.html: show this artist's rating for each unfilled
> category inline on the row, and show the banked rating next to the
> artist name once filled.

Once you like a result, port the change back into the matching component in
`game/index.html` (`HomeScreen`, `SlotReel`/`DraftFlow`, `ArtistAssignScreen`,
`ResultScreen`) — these seeds are static mockups, not the live game.

Note: "Star Power" (`sp` on each artist, and `starPowerAvg` in the scoring
code) is a hidden input to the scoring algorithm and must never be rendered
to the player — keep it out of any generated copy for `result_1.html`.
