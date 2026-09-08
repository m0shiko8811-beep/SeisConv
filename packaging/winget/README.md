# winget manifest for SeisConv

These files are a submission draft, not a published package. The winget catalogue
lives in Microsoft's own repository, so the manifest is delivered as a pull request
to [microsoft/winget-pkgs](https://github.com/microsoft/winget-pkgs) and does not
permanently live here. This folder is where the content is kept between submissions,
so each new release starts from the last one instead of from a blank page.

Package identifier: `MosheFridin.SeisConv`. Once merged, that string is the permanent
public path to the package (`manifests/m/MosheFridin/SeisConv/...`) and users install
it with `winget install MosheFridin.SeisConv`.

## What is here

```
manifests/m/MosheFridin/SeisConv/0.8.1/
  MosheFridin.SeisConv.yaml                 version manifest
  MosheFridin.SeisConv.installer.yaml       installer manifest
  MosheFridin.SeisConv.locale.en-US.yaml    default locale manifest
```

The folder layout mirrors the destination in `winget-pkgs` exactly, so the three files
can be copied across without rearranging anything.

## Facts baked into the draft

- **Installer**: `SeisConv-Setup-0.8.1.exe`, the NSIS installer from GitHub release
  `v0.8.1`. Pinned by version, not by `/latest`, which is what winget requires.
- **SHA256**: `6FB71BDC42222A716F56ED21BF5563E6F2C28AA5A66B85641AF37E11705B13BE`.
  Verified against the GitHub release API asset digest, not typed from memory.
- **InstallerType**: `nullsoft`. That is winget's enum value for NSIS; there is no
  `nsis` value.
- **Silent switch**: `/S`. The installer is built with electron-builder `nsis` and
  `oneClick: false`, so it is interactive by default. Without an explicit `Silent`
  switch the submission fails validation, because winget must be able to install
  unattended.
- **Scope is deliberately omitted.** The assisted NSIS installer lets the user pick
  "anyone who uses this computer" or "only for me", so it is neither strictly machine
  nor strictly user scoped. Under `/S` it installs per user with no UAC prompt.
- **ProductCode is deliberately omitted.** electron-builder derives the uninstall
  registry GUID from the `appId`, and it was not guessed here. Without it, winget
  matches the installed app on its Add/Remove Programs name and publisher, which
  works. It can be filled in later by reading the uninstall registry key on a machine
  that has SeisConv installed.
- **MinimumOSVersion is omitted.** The README states Windows 10 and 11, 64 bit, but
  not a build number, and the true Electron 44 floor was not confirmed. Add it only
  once it is known.
- **ManifestVersion is 1.6.0**, which the repository still accepts. `wingetcreate`
  will emit whatever schema version is current when the submission is made. Treat the
  files here as the content, and let the tool own the schema version.

## How to submit

The recommended path is `wingetcreate`, because it validates, forks, commits and opens
the pull request in one pass.

```powershell
winget install Microsoft.WingetCreate

# From the repo root. Point it at the release asset; it downloads the installer,
# computes the hash itself and pre-fills what it can detect.
wingetcreate new https://github.com/m0shiko8811-beep/SeisConv/releases/download/v0.8.1/SeisConv-Setup-0.8.1.exe
```

When it prompts, copy the field values out of the three YAML files in this folder so
the wording, tags, licence and URLs match what is kept here. It will ask to submit the
pull request at the end.

For a later release, `wingetcreate update MosheFridin.SeisConv --version <new> --urls <new url> --submit`
is a one liner, since the catalogue already holds everything else.

Manual alternative, if the tool is not wanted: fork `microsoft/winget-pkgs`, copy
`manifests/m/MosheFridin/SeisConv/0.8.1/` into the fork at the same path, validate with
`winget validate --manifest manifests/m/MosheFridin/SeisConv/0.8.1`, test locally with
`winget install --manifest manifests/m/MosheFridin/SeisConv/0.8.1`, then open a pull
request against `master`.

## What Moshe must do personally

1. **Sign the Microsoft Contributor License Agreement.** The CLA bot comments on the
   pull request within a minute of it opening and blocks the merge until it is signed.
   It is a click-through on the bot's link, done once, under the GitHub account that
   opened the pull request. Nobody can sign it on his behalf.
2. Approve the fork and the pull request, since they are created under his account.
3. Answer anything a maintainer asks on the thread.

## Honest warning about validation

Microsoft's validation pipeline runs the installer through multiple antivirus engines.
A 100 MB unsigned Electron NSIS installer is a textbook heuristic false positive: it is
large, it is compressed, it is unsigned, and it unpacks an executable at install time.
A "Validation-Defender-Error" or similar label on the pull request is a plausible
outcome and does not mean anything is actually wrong with the build.

The remedy is not to rebuild. It is to submit the installer to Microsoft's Security
Intelligence portal as a false positive, at
[microsoft.com/en-us/wdsi/filesubmission](https://www.microsoft.com/en-us/wdsi/filesubmission),
choosing the "software developer" route, then comment on the pull request asking a
moderator to re-run validation once the detection is cleared. Turnaround is usually a
day or two.

Getting the app into the Microsoft Store fixes this class of problem at the root, since
the Store signs the package with a Microsoft certificate.
