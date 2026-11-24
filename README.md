# Independent release check sandbox

This repository contains only synthetic data. It has no production deployment or Pages.

The trusted main workflow validates the GitHub test merge tree. Candidate code is never run. The application posts a commit status only on the verified test merge SHA.

The sandbox fixture is pre-registered at bootstrap. All later changes to trusted workflow and approval code require repository review. This sandbox cannot authorize production releases.
