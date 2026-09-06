# Offline land layer

`land.geojson` is Natural Earth's 1:110m land dataset, downloaded 2026-09-06.
It provides geographic context without a tile server, credentials or runtime
internet access. No political boundaries are drawn.

- [Source](https://github.com/nvkelso/natural-earth-vector/blob/master/geojson/ne_110m_land.geojson)
- [Public-domain terms](https://www.naturalearthdata.com/about/terms-of-use/)

The original coordinates and properties are preserved. A configured raster
template is drawn over this layer; if that provider fails, the land remains.
