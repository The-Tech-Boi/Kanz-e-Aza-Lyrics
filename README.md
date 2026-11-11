# Kanz-e-Aza-Lyrics
A public, continuously updated dataset of Azadari and Karbala-related lyrics, curated for open use by apps, researchers, and the community.

This repository holds the **Catalog**: the current version of every published lyric, one file each. The Kanz e Aza app and website are built from it and receive every change to it.

## Getting the lyrics

Clone the repository, or use **Code → Download ZIP** on GitHub. Everything is in `lyrics/`.

To browse on GitHub, open [`index/`](index/): one page per category, listing titles by personality, each linking to its file.

## Layout

| Path | What it holds |
| --- | --- |
| `lyrics/<xx>/<remoteId>.json` | One lyric. `<xx>` is the last two characters of its `remoteId`, lowercase. Folders go by id, not category, so a file never moves when its details change. |
| `index/<Category>.md` | Generated on every publish. Don't edit. |
| `taxonomy.json` | The built-in personalities ("subjects") and their order for each category. |
| `manifest.json`, `updates/` | What the app and website download to stay current: each update lists the lyrics that changed and the ids removed. |

## A lyric file

```json
{
  "remoteId": "local_fd7a8aaf945e59455b8a44f5e5a5d9cf",
  "title": "Aye mere baradar e eemani",
  "body": "Aye mere baradar e eemani\n<<DIVIDER>>\nmat ghayr se apni yaari rakh",
  "language": "Roman Urdu",
  "categories": ["Nohay"],
  "subcategory": "Moula Abbas (a.s)",
  "group": 2019,
  "author": "Mir Anees",
  "anjumans": [],
  "verified": false
}
```

| Field | |
| --- | --- |
| `remoteId` | The lyric's id. It never changes, and it names the file. |
| `title`, `body` | The lyric. In `body`, a line `<<DIVIDER>>` separates stanzas and `<<MINI>>` marks a short break within one. |
| `styling` | Optional. How the lyric is shown, set in the app's Writer: line alignment, bold, italic, underline, size, lists and direction, as a [Quill delta](https://quilljs.com/docs/delta) (an array of `insert` operations). It never changes the words: line *n* of `styling` is line *n* of `body`, and `body` is what counts. Absent when the lyric has none. |
| `language` | `Roman Urdu` or `Urdu`. |
| `categories` | One or more of Nohay, Manqabat, Salaams, Marsiya, Munajat, Qasida, or a category added since. |
| `subcategory` | Optional. The personality, event or topic it is about (see `taxonomy.json`; others are allowed). |
| `group` | Optional. The release year. |
| `author` | Optional. The poet. Never the reciter. |
| `anjumans` | The Anjumans that recite it. A lyric in an Anjuman includes the Nohay category. |
| `verified` | Whether the text has been checked against a trusted source. |

`scripts/catalog.js` holds the exact rules every file is checked against.

## History

A lyric's history is its file's history: open the file on GitHub and choose **History**, or run `git log -p -- lyrics/<xx>/<remoteId>.json`. Each change is committed by the sync, which names the kind of change (new, suggested edit, admin edit, Owner edit, verified, unverified, withdrawal, restore) and never who made it.

## Corrections

To correct a lyric, use **Suggest an edit** on [kanz-e-aza.com](https://kanz-e-aza.com) or in the app. Admins review every suggestion, and an approved one is published here within hours, as a change to the same file.

Pull requests changing `lyrics/` are not merged unless they come from the repository owner, so send corrections through **Suggest an edit** instead.

## Publishing

The workflow `sync_lyrics.yml` publishes everything approved every 6 hours, and the Owner's merged pull request to `lyrics/` at once.

A run publishes at most 2,000 changed lyrics (records plus removals): phones on 1.1.2 and 1.1.3 apply a whole run back to back. Raise or drop the limit (`RUN_LYRICS` in `scripts/catalog.js`) once most phones run 1.1.4. The Owner's merged pull requests go first, whole and in the order they were merged; then approvals, the longest waiting first. What doesn't fit stays pending and goes out in the next runs: an approval stays unpublished in Firestore, a merged pull request stays after the manifest's `catalogTree`. A pull request that changes more than 2,000 lyrics fails its check as a warning: merged anyway, it goes out whole in a run of its own, and old phones apply it all at once. Publishing never stops for it.

A run writes its changes in update files of at most 500 lyrics and 2,000,000 bytes each (`update_<ms>`, 1 ms apart), in one release and one commit. `manifest.json` lists at most 1,000 updates: from 500 the sync warns, and over 1,000 it stops before publishing anything. The Owner then removes old entries in a reviewed pull request, never the sync: only updates published before the Base Catalog of the oldest app build still supported was copied, since every supported build already holds their lyrics. `update_1793650281638` (547 lyrics) was published before these limits and stays as it is.

An Admin's own edit is published within minutes. The watchdog `scripts/admin_edit_watchdog.js` listens to Firestore for approved, unpublished submissions. A minute after the first Admin edit, it starts the workflow with `only_if_admin_edit`, and that run publishes everything approved so far. Each submission gets one run: if the run fails, the submission waits for the 6-hour batch. When the watchdog is down, Admin edits wait for the 6-hour batch too.

It runs on Coolify (project *Kanz e Aza*, application *admin-edit-watchdog*), built from the `Dockerfile` on `main`. Two secrets, set as Coolify environment variables:

| Variable | What it holds |
| --- | --- |
| `FIREBASE_SERVICE_ACCOUNT` | Base64 of a JSON key for a read-only service account (role *Cloud Datastore Viewer*). Not the sync workflow's account. |
| `GITHUB_TOKEN` | A fine-grained token for this repository only, with *Actions: read and write* and nothing else. |

To restart it, open the application in Coolify and choose **Restart**; after a change to the watchdog, choose **Redeploy**. On start-up it starts one run for any Admin edit already waiting. Its log is under **Logs**. It exits on a Firestore error it can't recover from, and Coolify starts it again.

## Licence

Lyrics that contributors send under the Kanz e Aza Contribution Terms, and that are published here, are licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) (see [LICENSE](LICENSE)). You may copy, share and adapt them for any purpose, including in your own apps, if you credit the poet and Kanz e Aza, link to the licence and say if you changed the text.

The licence doesn't cover any other lyrics in this repository or its releases, including the base catalog snapshot and lyrics published before the Contribution Terms took effect. Their rights stay with their poets and rights holders.
