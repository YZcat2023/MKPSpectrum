# MKPSpectrum OrcaSlicer fork

This repository is the upstream-facing home of **MKPSpectrum**'s OrcaSlicer build
(Snapmaker U1 / mBrush inkjet integration).

## Purpose of this repo today

It hosts the **release feed** consumed by the in-app update check
(Help -> Check for Updates) of the MKPSpectrum OrcaSlicer build, replacing
`check-version.orcaslicer.com`.

The client requests:

    https://api.github.com/repos/YZcat2023/OrcaSlicer/releases?per_page=10

and reads GitHub's release JSON (`tag_name`, `prerelease`, `html_url`, `body`),
so release tags must be plain semver, e.g. `v2.5.1`, `v2.6.0-beta1`.

## Licence

OrcaSlicer is licensed under **AGPL-3.0**. Modified sources will be published
here when the binary is distributed.

## Upstream

https://github.com/SoftFever/OrcaSlicer