# NYC Cabe Rides

Visualize aggregated Yellow Cab trip data in New York City from July 2015 - June 2016. 

[Live Demo here](http://vannizhang.github.io/nyc-cab-rides).

![screenshot](screenshot.png?raw=true)

The data are rendered into hexagon grid with different sizes/colors using following libraries

- [ArcGIS JavaScript API](https://developers.arcgis.com/javascript/index.html)
- [D3](https://d3js.org/)
- [leaflet-knn](https://github.com/mapbox/leaflet-knn)
- [turf.js](http://turfjs.org/)

The raw data (over 130 millions) are downloaded from [NYC Taxi & Limousine Commission](http://www.nyc.gov/html/tlc/html/about/trip_record_data.shtml), processed and aggregated using PostgreSQL database with PostGIS.

