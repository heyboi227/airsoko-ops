# Offline land layer

`land.geojson` is Natural Earth's 1:50m land dataset, downloaded 2026-10-18 and kept
byte for byte as published, so `git hash-object land.geojson` prints the source's blob,
`c412c52b5286ba727dcb7047ecd6080bcbeb8298`. It provides geographic context without a
tile server, credentials or runtime internet access. No political boundaries are drawn.

- [Source](https://github.com/nvkelso/natural-earth-vector/blob/693f11422f4e08d2da4566b854dda53eb7c39fb3/geojson/ne_50m_land.geojson),
  at commit `693f114`
- [Public-domain terms](https://www.naturalearthdata.com/about/terms-of-use/)

It replaced the 1:110m dataset, whose coastline was coarse enough at zoom 3 to 5 to leave
coastal airports offshore. The finer file is 1.6 MB; the coarse one was 224 KB as
committed, which Prettier had reformatted from 138 KB. This one is listed in
`.prettierignore`, since reformatting would make it larger and no longer comparable with
its source.

A configured raster template is drawn over this layer; if that provider fails, the land
remains.
