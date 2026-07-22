# GitHub Automation Setup Guide (Dual-Repository)

This guide explains how to set up the automated synchronization for the **Dual-Repository Architecture**. 

*   **App Repo (Private)**: Contains your code.
*   **Data Repo (Public)**: Contains lyrics and releases (`Kanz-e-Aza-Lyrics`).

---

## Step 1: Create the Data Repository
1.  Go to GitHub and create a **New Repository**.
2.  Name it **`Kanz-e-Aza-Lyrics`**.
3.  Set Visibility to **Public**.
4.  Initialize it with a `README.md`.

---

## Step 2: Generate Firebase Service Account
1.  Open the [Firebase Console](https://console.firebase.google.com/).
2.  Select your **RomanUrduLyrics** project.
3.  Click **Project Settings** (gear icon) > **Service accounts**.
4.  Click **Generate new private key**.
5.  Save the JSON file. **Do NOT commit this file.**

---

## Step 3: Configure Secrets on the DATA Repository
You must add secrets to the **`Kanz-e-Aza-Lyrics`** repository (NOT the app repo).

1.  Open `Kanz-e-Aza-Lyrics` on GitHub.
2.  Go to **Settings** > **Secrets and variables** > **Actions**.
3.  **Secret 1: `FIREBASE_SERVICE_ACCOUNT`**
    *   **Encode**: Convert your JSON key to Base64 (single line).
        *   *Windows (PowerShell)*: `[Convert]::ToBase64String([IO.File]::ReadAllBytes("path/to/key.json")) | Set-Clipboard`
    *   Paste the Base64 string as the value.
4.  **Secret 2: `GH_TOKEN`**
    *   Create a [Personal Access Token](https://github.com/settings/tokens?type=beta).
    *   **Permission Selection**:
        *   **Fine-grained Token (Beta)**: Select this repository and grant **Read and Write** access to **Contents** and **Releases**.
        *   **Classic Token**: Select the **`repo`** scope (or **`public_repo`** for public repositories). This covers the contents/releases permissions.
    *   Paste the token as the value.


---

## Step 4: Push Automation Scripts to DATA Repository
You need to push the synchronization code to `Kanz-e-Aza-Lyrics`.

1.  Clone `Kanz-e-Aza-Lyrics` to your machine.
2.  Create a folder `scripts/` and add the `sync_firestore_to_github.js` script (from your docs/plans).
3.  Create a folder `.github/workflows/` and add `sync_lyrics.yml`.
4.  Create a `package.json` with dependencies (`firebase-admin`, `@octokit/rest`).
5.  Commit and Push these files to `main`.

---

## Step 5: Verify
1.  Go to the **Actions** tab in `Kanz-e-Aza-Lyrics`.
2.  Manually run the **Sync Lyrics** workflow.
3.  Ensure a new **Release** is created with `manifest.json`.
4.  Open the release and confirm the assets include:
    *   `manifest.json`
    *   `update_*.json`
    *   `published_docs.json`
5.  Confirm Firestore submissions are marked `published: true` only after the release exists.

---

## Current sync safety model

The workflow intentionally uses a two-phase publication process:

1.  `scripts/sync_firestore_to_github.js`
    *   Reads Firestore `submissions` where `status == 'approved'` and `published == false`.
    *   Generates `output/update_*.json`, `output/manifest.json`, and `output/published_docs.json`.
    *   Does **not** mark Firestore documents as published.

2.  GitHub Actions creates the public GitHub Release.

3.  `scripts/mark_published.js`
    *   Re-checks that the release exists.
    *   Verifies required assets are present.
    *   Only then updates Firestore with `published: true`, `publishedAt`, and `publishedReleaseTag`.

This prevents a failed GitHub release from stranding approved lyrics as already-published in Firestore.

### Release tag format

Data releases use tags like:

```text
updates-vYYYYMMDD-HHMMSS-<github_run_id>
```

Example:

```text
updates-v20260716-183045-987654321
```

The workflow creates this once and passes the same `RELEASE_TAG` to both scripts and to the GitHub Release step. The manifest's `releaseTag` must exactly match the real GitHub Release tag because the mobile app builds asset download URLs from that value.

Do not use app-version-style tags such as `v1.0.x` for these data releases unless the mobile app and workflow are migrated together.

---

## Step 6: Update the App (Already Done)
*   The `update_service.dart` in your App Repo has already been updated to point to `Kanz-e-Aza-Lyrics`.
*   Build and release your app. It will now fetch updates from the public data repo.
