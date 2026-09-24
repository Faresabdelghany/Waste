# DAWA snapshot: municipalities and postcodes

Build-order step 1 of `docs/architecture/backend-architecture.md`: DAWA
(Danmarks Adressers Web API, `api.dataforsyningen.dk`) closes on 2026-10-01,
so the two DAGI layers the Registry will need are kept here, retrieved
2026-09-24 and unchanged since. Nothing reads them yet; the migration that
loads them arrives with the Registry tables.

| File | Request | Features | Geometry | Latest `geo_ændret` |
| --- | --- | --- | --- | --- |
| `kommuner.geojson.gz` | `GET /kommuner?format=geojson&srid=4326` | 99 | MultiPolygon | 2026-03-27 |
| `postnumre.geojson.gz` | `GET /postnumre?format=geojson&srid=4326` | 1089 | MultiPolygon | 2026-04-20 |

Both are GeoJSON `FeatureCollection`s in EPSG:4326 (longitude, latitude),
gzip-compressed with `gzip -9` and otherwise byte-for-byte what the API
returned. Uncompressed they are 119 MB and 73 MB.

Properties: `kommuner` carries `kode`, `navn`, `regionskode`, `regionsnavn`,
`dagi_id`, `udenforkommuneinddeling`, `visueltcenter_x`/`_y`; `postnumre`
carries `nr`, `navn`, `stormodtager`, `dagi_id`, `visueltcenter_x`/`_y`. Every
feature also carries `geo_version` and `geo_ændret` from DAGI.

## Checksums (sha256)

```
1adaa13e4dc6707fd568f94e3552ae4d24e6905c5de9fdcad53170324d376530  kommuner.geojson.gz
74ad58fb42ed7e2fa540ed996c5105d6ee25ac5a9d9d3d74000bd8f8c35b52b7  postnumre.geojson.gz
cd386c05d956c6cd5aec1797932a9ae003d90c300d1f549325cb1c9288c6a11f  kommuner.geojson
410dff373309e4373716492779ab10c4575103d59024fd11d164a65204693e85  postnumre.geojson
```

## Licence and attribution

The data is Klimadatastyrelsen's (DAGI, Danmarks Administrative Geografiske
Inddeling), published through DAWA under CC BY 4.0. Any surface that shows it
attributes it: "Indeholder data fra Klimadatastyrelsen" (contains data from
the Danish Climate Data Agency). After 2026-10-01 the live source is
Datafordeleren; these files are the snapshot, not a feed.
