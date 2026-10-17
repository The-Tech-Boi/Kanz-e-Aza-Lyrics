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
  "subcategory": "Hazrat Abbas (a.s)",
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
| `language` | `Roman Urdu` or `Urdu`. |
| `categories` | One or more of Nohay, Manqabat, Salaams, Marsiya, Munajat, Qasida, or a category added since. |
| `subcategory` | Optional. The personality, event or topic it is about (see `taxonomy.json`; others are allowed). |
| `group` | Optional. The release year. |
| `author` | Optional. The poet. Never the reciter. |
| `anjumans` | The Anjumans that recite it. A lyric in an Anjuman is a Nohay. |
| `verified` | Whether the text has been checked against a trusted source. |

`scripts/catalog.js` holds the exact rules every file is checked against.

## History

A lyric's history is its file's history: open the file on GitHub and choose **History**, or run `git log -p -- lyrics/<xx>/<remoteId>.json`. Each change is committed by the sync, which names the kind of change (new, suggested edit, admin edit, Owner edit, withdrawal, restore) and never who made it.

## Corrections

To correct a lyric, use **Suggest an edit** on [kanz-e-aza.com](https://kanz-e-aza.com) or in the app. Admins review every suggestion, and an approved one is published here within hours, as a change to the same file.

Pull requests changing `lyrics/` are not merged unless they come from the repository owner, so send corrections through **Suggest an edit** instead.

## Licence

Lyrics that contributors send under the Kanz e Aza Contribution Terms, and that are published here, are licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) (see [LICENSE](LICENSE)). You may copy, share and adapt them for any purpose, including in your own apps, if you credit the poet and Kanz e Aza, link to the licence and say if you changed the text.

The licence doesn't cover any other lyrics in this repository or its releases, including the base catalog snapshot and lyrics published before the Contribution Terms took effect. Their rights stay with their poets and rights holders.
