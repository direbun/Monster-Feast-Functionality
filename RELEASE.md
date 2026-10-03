# Publishing version 1.1.0

The local release folder contains two different uploads:

- **github-source/**: upload the CONTENTS of this folder into the root of the
  GitHub repository. Do not upload the enclosing github-source folder.
- **assets/**: attach module.json and module.zip to the GitHub Release as release
  assets. They are already built and ready to upload.

Repository: https://github.com/direbun/Monster-Feast-Functionality

## GitHub steps

1. Upload the contents of github-source to the repository's main branch.
2. Create a GitHub Release with the exact tag **v1.1.0**.
3. Use **Monsters Feast - Functionality 1.1.0** as its title.
4. Copy the release-notes.md text into the release description.
5. Attach BOTH assets/module.json and assets/module.zip. Keep those filenames.
6. Publish as the latest stable release (not a draft or prerelease).

Do not use GitHub's automatically generated Source code zip as the Foundry
download. The supplied module.zip contains module.json at its root alongside
scripts/, styles/ and templates/. It excludes development tests and release
staging folders.

## Foundry installation URL

After the release is published, paste this manifest URL into Foundry's
Install Module dialog:

https://github.com/direbun/Monster-Feast-Functionality/releases/latest/download/module.json

The download URL deliberately targets the versioned v1.1.0 release. The update
manifest follows the latest stable release.

The module ID remains monsters-feast-functionality to preserve compatibility
with existing world data and module settings.

## Future releases

Update the version and versioned download URL in the root module.json together.
Rebuild the package with the changed runtime files, then upload a matching
manifest and ZIP under the matching release tag. Do not reuse these 1.1.0
assets after changing source files.

## Development notes

The tests use the installed sibling ionrift-monstrous-feast module as an
integration fixture; they are not standalone tests on a fresh GitHub checkout.
See README.md for current compatibility and verification limits.

No license has been selected or added; choose one separately if desired.
