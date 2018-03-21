require([
    "esri/map", 
    "esri/geometry/Point", "esri/geometry/Polygon", "esri/graphic",
    "esri/symbols/SimpleFillSymbol", "esri/symbols/SimpleLineSymbol", "esri/Color",
    "esri/SpatialReference", "esri/geometry/webMercatorUtils",
    "modules/CanvasLayer",
    "esri/request",
    "dojo/domReady!"
], function (
    Map, Point, Polygon, Graphic, 
    SimpleFillSymbol, SimpleLineSymbol, Color, 
    SpatialReference, webMercatorUtils,
    CanvasLayer,
    esriRequest
) {
    "use strict";

    const BASEMAP = "dark-gray"; //"gray"; 
    const FILL_COLOR_FOR_SELECTED_HEX = "rgba(254, 70, 77,.9)";
    const FILL_COLOR_FOR_PICKUP = [
        "rgba(150,150,150,0)",
        "rgba(229,245,224,0.7)",
        "rgba(199,233,192,0.7)",
        "rgba(161,217,155,0.7)",
        "rgba(116,196,118,0.7)",
        "rgba(65,171,93,0.7)"
    ];
    const FILL_COLOR_FOR_DROPOFF = [
        "rgba(150,150,150,0)",
        "rgba(222,235,247,0.7)",
        "rgba(198,219,239,0.7)",
        "rgba(158,202,225,0.7)",
        "rgba(107,174,214,0.7)",
        "rgba(66,146,198,0.7)"
    ];

    var app = new NYCTaxiDataVizApp();

    app.map.on("load", function(){
        queue()
            .defer(d3.json, 'assets/nyc_hexagon_grid_filtered_centroid.geojson')
            .defer(d3.csv, 'assets/nyc_hex_grid_with_pickup_data.csv')
            .defer(d3.csv, 'assets/nyc_hex_grid_with_dropoff_data.csv')
            .defer(d3.json, 'assets/pickup_by_month.json')
            .defer(d3.json, 'assets/dropoff_by_month.json')
            .await(mapDataReadyHandler);
    });

    function NYCTaxiDataVizApp(){
        this.cosines = getCosines();
        this.sines = getSines();
        this.hexGridMaker = new HexGridMaker();
        this.highlightHexgaonStyle = getHighlightHexagonStyle();
        this.paymentTypeData = [
            {'key': 'sum_of_payment_by_card', 'label': 'Payment By Card', 'value': 0},
            {'key': 'sum_of_payment_by_cash', 'label': 'Payment By Cash', 'value': 0}
        ];
        this.avgTip = 0;
        this.map = new Map("map", {
            basemap: BASEMAP,  //For full list of pre-defined basemaps, navigate to http://arcg.is/1JVo6Wd
            center: [-73.9759, 40.7728], // longitude, latitude
            zoom: 12
        });
    }

    function mapDataReadyHandler(error, centroids, pickupData, dropoffData, pickupByMonth, dropoffByMonth) {
        if (error) throw error;

        app.hexGridCentroids = centroids;

        //create a lookup index layer for the hex grid, that will be used to find the nearest point
        if(!app.hexGridCentroidsIndex){
            app.hexGridCentroidsIndex = leafletKnn(L.geoJson(app.hexGridCentroids));
        }

        app.map.on("click", function(){
            app.selectedHexGridId = app.currentHexGridIdOnMouseover;
            updateHexGridLayer(app.selectedHexGridId);
        });

        app.map.on("mouse-move", function(evt){
            findNearestHexagon(evt); 
        });

        app.map.on("mouse-out", function(evt){
            removeHighlightHexagon();
        });

        app.PICK_UP_DATA_ALL_HEX = pickupData;
        app.DROP_OFF_DATA_ALL_HEX = dropoffData;

        app.PICK_UP_BY_MONTH = pickupByMonth;
        app.DROPOFF_BY_MONTH = dropoffByMonth;

        drawAllHexGrids();
    }

    function updateHexGridLayer(gridID){
        toggleLoadingIndicator(true);
        var tripType = getTripType();
        var baseURL = "https://nyctaxi.vannizhang.com/";
        var requestURL = baseURL + "getTrips";
        
        var filterValues = getFilterValues();
        filterValues.locationID = gridID;

        $.ajax({
            url: requestURL,
            type:'get',
            data: filterValues,
            dataType: 'json',
            success: function(response) {
                // console.log(response);
                populateHexGridLayer(response.results, true);
                app[tripType+'DataForSelectedHex'] = {
                    gridID: gridID,
                    data: response.results
                };
            },
            error: function(xhr) {
                toggleLoadingIndicator(false);
                app[tripType+'DataForSelectedHex'] = undefined;
                //Do Something to handle error
            }
        });
    }

    function getFilterValues(){
        var tripType = getTripType();
        var filterValues = {
            "tripType": tripType,
        }
        return filterValues;
    }

    function HexGridMaker(){
        const bbox = [-74.07085418701172,40.76780169022038,-73.7412643432617, 40.897684312779774];
        const cellDiameter = 0.66;
        const units = 'kilometers';

        const west = bbox[0];
        const south = bbox[1];
        const east = bbox[2];
        const north = bbox[3];
        const centerY = (south + north) / 2;
        const centerX = (west + east) / 2;

        const xFraction = cellDiameter / (turf.distance([west, centerY], [east, centerY], units));
        const cellWidth = xFraction * (east - west);
        const yFraction = cellDiameter / (turf.distance([centerX, south], [centerX, north], units));
        const cellHeight = yFraction * (north - south);
        const defaultSizeRatio = .9;

        this.getHexByCoord = function(coordinates){
            return hexagon(coordinates, cellWidth / 2 * defaultSizeRatio, cellHeight / 2 * defaultSizeRatio);
        }

        this.getHexGird = function(pointFeatures, shouldCreateCharts){

            var attrNameForSize = 'count_of_trips';
            // var attrNameForColor = attrNameForColor || attrNameForSize;
            var attrNameForColor = getAttrToDisplayFromSelect();
            var fc = turf.featureCollection([]);
            var inputDataRangeForSize = getRange(pointFeatures, attrNameForSize);
            var inputDataRangeForColor = getRange(pointFeatures, attrNameForColor);
            var quantizeForSize = d3.scaleQuantile().domain(inputDataRangeForSize).range([0, .2, .4, .6, .8, 1]);
            var quantizeForColor = d3.scaleQuantile().domain(inputDataRangeForColor).range([1, 1, 2, 3, 4, 5]);
            

            if(pointFeatures.length > 1){
                // console.log('rangeForColorDomain', inputDataRange);
                // console.log('quantizeForColor quantiles', quantizeForSize.quantiles());
                populateLegend(quantizeForSize.quantiles(), quantizeForColor.quantiles(), attrNameForColor);
            }

            if(shouldCreateCharts){
                // console.log('create charts');
                drawBarChartFromMonthlyTrips(app.selectedHexGridId);
                drawDonutChartForPaymentType();
                drawTipsChart();
            }

            pointFeatures.forEach(function(d, i){
                var pointGeometry = d.geometry.coordinates;

                if(!(i % 1)){
                    var colorRampClass = (+d.properties[attrNameForColor]) ? quantizeForColor(+d.properties[attrNameForColor]) : 0;
                    var ratio = (+d.properties[attrNameForSize]) ? quantizeForSize(+d.properties[attrNameForSize]) * defaultSizeRatio : defaultSizeRatio;
                    ratio = !ratio ? .1 : ratio; 
                    
                    var f = hexagon(pointGeometry, cellWidth / 2 * ratio, cellHeight / 2 * ratio);
                    f.properties = d.properties;
                    f.properties.colorRampClass = colorRampClass;
                    fc.features.push(f);
                }
            });

            return fc;
        }
    }

    function populateHexGridLayer(tripsData=[], shouldCreateCharts=false){

        var tripType = getTripType();
        var sumOfCosts = 0;
        var sumOfTips = 0;

        tripsData = JSON.parse(JSON.stringify(tripsData));
        resetPaymentTypeData();

        if(tripsData.length){
            app.hexGridCentroids.features.forEach(function(d, i){
                if(tripsData.length && +d.properties.grid_index === +tripsData[0].grid_index) {
                    d.properties.count_of_trips = +tripsData[0].total_trips;
                    d.properties.avg_of_costs = (tripsData[0].total_trips) ? tripsData[0].sum_of_costs / tripsData[0].total_trips : 0;
                    d.properties.avg_of_passengers =  (tripsData[0].total_trips) ? tripsData[0].sum_of_passengers / tripsData[0].total_trips : 0;
                    d.properties.pct_of_tips = (tripsData[0].sum_of_costs) ? tripsData[0].sum_of_tips / tripsData[0].sum_of_costs : 0;
                    d.properties.pct_of_payment_by_card = tripsData[0].count_of_payment_by_card / tripsData[0].total_trips;
                    d.properties.pct_of_payment_by_cash = tripsData[0].count_of_payment_by_cash / tripsData[0].total_trips;
                    d.properties.avg_of_duration_in_min = (tripsData[0].total_trips) ? (tripsData[0].sum_of_duration_in_seconds / 60) /  tripsData[0].total_trips : 0;
                    
                    app.paymentTypeData[0].value += tripsData[0].count_of_payment_by_card;
                    app.paymentTypeData[1].value += tripsData[0].count_of_payment_by_cash;

                    sumOfCosts += +tripsData[0].sum_of_costs;
                    sumOfTips += +tripsData[0].sum_of_tips;

                    tripsData.shift();
                } else {
                    d.properties.count_of_trips = 0;
                    d.properties.avg_of_costs = 0;
                    d.properties.avg_of_passengers = 0;
                    d.properties.pct_of_tips = 0;
                    d.properties.pct_of_payment_by_card = 0;
                    d.properties.pct_of_payment_by_cash = 0;
                    d.properties.avg_of_duration_in_min = 0;
                }
            });
        } else {
            app.hexGridCentroids.features.forEach(function(d, i){
                d.properties.count_of_trips = 0;
                d.properties.avg_of_costs = 0;
                d.properties.avg_of_passengers = 0;
                d.properties.pct_of_tips = 0;
                d.properties.pct_of_payment_by_card = 0;
                d.properties.pct_of_payment_by_cash = 0;
                d.properties.avg_of_duration_in_min = 0;
            });
        }

        app.avgTip = sumOfTips/sumOfCosts;
        app.hexGrid = app.hexGridMaker.getHexGird(app.hexGridCentroids.features, shouldCreateCharts);

        if(!app.canvasLayer){
            app.canvasLayer = new HexagonLayer(app.hexGrid.features);
        } else {
            app.canvasLayer.redraw(app.hexGrid.features);
        }

    }

    function resetPaymentTypeData(){
        app.paymentTypeData.forEach(d=>{
            d.value = 0;
        });
    }

    function redrawHexGridLayer(){
        if(app.selectedHexGridId){
            // console.log('redraw hexgrid for', app.selectedHexGridId);
            drawHexGridsForSelectedItem(app.selectedHexGridId);
        } else {
            drawAllHexGrids()
        }
    }

    function drawHexGridsForSelectedItem(gridID){
        var tripType = getTripType();
        var prevSelectedHex = app[tripType+'DataForSelectedHex'];
        // console.log(prevSelectedHex);
        
        if(prevSelectedHex && prevSelectedHex.gridID === gridID){
            populateHexGridLayer(prevSelectedHex.data, true);
            // console.log('redraw hexgrid using prevSelectedHex', prevSelectedHex);
        } else {
            updateHexGridLayer(gridID);
            // console.log('draw hexgrid by pulling data from server for', gridID);
        }
    }

    function drawAllHexGrids(){
        var tripType = getTripType();

        if(!app.PICK_UP_DATA_ALL_HEX || !app.DROP_OFF_DATA_ALL_HEX){
            console.log('app.PICK_UP_DATA_ALL_HEX or app.DROP_OFF_DATA_ALL_HEX is undefined');
            return;
        }

        if(tripType==='pickup'){
            populateHexGridLayer(app.PICK_UP_DATA_ALL_HEX);
        } else {
            populateHexGridLayer(app.DROP_OFF_DATA_ALL_HEX);
        }
    }

    function getAttrToDisplayFromSelect(){
        return $('.select-attr-to-display').val();
    }

    function hexagon(center, rx, ry) {
        var vertices = [];
        for (var i = 0; i < 6; i++) {
            var x = center[0] + rx * app.cosines[i];
            var y = center[1] + ry * app.sines[i];
            vertices.push([x, y]);
        }
        //first and last vertex must be the same
        vertices.push(vertices[0]);
        return turf.polygon([vertices]);
    }

    function HexagonLayer(hexgaonFeatures){
        var canvasLayer = new CanvasLayer(null, {"id": "canvasLayer"});
        app.map.addLayer(canvasLayer);
        app.map.on("extent-change", ()=>{
            // console.log('redraw canvas');
            this.redraw();
        });
        app.map.on("resize", ()=>{
            // console.log('redraw canvas');
            this.redraw();
        });

        this.redraw = function(data){

            if(data){
                this.data = data;
            }

            canvasLayer.clear();
            canvasLayer._element.width = app.map.width;
            canvasLayer._element.height = app.map.height;

            var ctx = canvasLayer._context;
            var tripType = getTripType();

            let count = 0;

            this.data.forEach(function(element, index) {
                ctx.fillStyle = 'rgba(0,0,0,0)'; // reset fill color
                let polygonCoordinates = element.geometry.coordinates[0];
                let fillColor = (element.properties.gridID !== app.selectedHexGridId) ? getHexagonColor(element.properties.colorRampClass, tripType) : FILL_COLOR_FOR_SELECTED_HEX;
                ctx.fillStyle = fillColor;

                for (let i = 0; i < polygonCoordinates.length; i++) {
                    let coord = polygonCoordinates[i];
                    let geometry = new Point(coord[0], coord[1], new SpatialReference({ wkid: 4326 })); 
                    let dot = app.map.toScreen(geometry);

                    if(i===0){
                        ctx.beginPath();
                        ctx.moveTo(dot.x, dot.y);
                    } else {
                        ctx.lineTo(dot.x, dot.y);
                        if (i === polygonCoordinates.length - 1){
                            ctx.fill();
                            ctx.closePath();
                        }
                    }
                }
            });
            toggleLoadingIndicator(false);
        }

        this.redraw(hexgaonFeatures);
    }

    function findNearestHexagon(evt){
        var normalizedCoord = webMercatorUtils.xyToLngLat(evt.mapPoint.x, evt.mapPoint.y);
        var lon= normalizedCoord[0]; 
        var lat = normalizedCoord[1];

        var nearest = app.hexGridCentroidsIndex.nearest(L.latLng(lat, lon), 1, 805); //805 is the maximum search diatnce in meters, which equals to half mile

        if(nearest.length){
            //check the grid id of element on mouse over to prevent multiple triggers over same hexagon
            if(app.currentHexGridIdOnMouseover !== nearest[0].layer.feature.properties.gridID){
                app.currentHexGridIdOnMouseover = nearest[0].layer.feature.properties.gridID;
                var hexagonForNearestFeature = app.hexGridMaker.getHexByCoord(nearest[0].layer.feature.geometry.coordinates);
                addHighlightHexagonForMouseOverEvt(hexagonForNearestFeature);
                showSummaryInfoWindow(nearest[0].layer.feature, evt);
            } else {
                return;
            }
        } else {
            //hide info window and highlight hexagon graphic
            removeHighlightHexagon();
            showSummaryInfoWindow(false);
            // console.log("no hexagon is found");
        }
    }

    function addHighlightHexagonForMouseOverEvt(hexagonFeature){
        var arrayOfHexagonCoord = hexagonFeature.geometry.coordinates[0];
        var polygonJson  = {"rings":[arrayOfHexagonCoord],"spatialReference":{"wkid":4326 }};
        var polygonGeom = new Polygon(polygonJson);
        var hexagonGraphic = new Graphic(polygonGeom, app.highlightHexgaonStyle);

        removeHighlightHexagon();
        app.map.graphics.add(hexagonGraphic);
        // console.log(hexagonFeature);
    }

    function removeHighlightHexagon(){
        app.map.graphics.clear();
    }

    function drawTipsChart(){
        // console.log(app.avgTip);
        var avgTip = app.avgTip;
        var barWidthRatio = 0;
        if(avgTip >= .3){
            barWidthRatio = 100;
        } else {
            barWidthRatio = avgTip/ .3;
        }
        $('#tips-chart-bar').css('width', barWidthRatio * 100 + '%');
        $('.tips-chart-label').text(round(avgTip * 100, 0) + '%');
    }

    function drawBarChartFromMonthlyTrips(gridID){

        $('.chart-reminder-message').addClass('hide');
        $('.chart-wrap').removeClass('hide');

        var tripType = getTripType();
        var countOfTripsByMonth = (tripType === 'pickup') ? app.PICK_UP_BY_MONTH[gridID] : app.DROPOFF_BY_MONTH[gridID];
        var chartData = [
            {'month': 1, "trips": 0},
            {'month': 2, "trips": 0},
            {'month': 3, "trips": 0},
            {'month': 4, "trips": 0},
            {'month': 5, "trips": 0},
            {'month': 6, "trips": 0},
            {'month': 7, "trips": 0},
            {'month': 8, "trips": 0},
            {'month': 9, "trips": 0},
            {'month': 10, "trips": 0},
            {'month': 11, "trips": 0},
            {'month': 12, "trips": 0},
        ];
        countOfTripsByMonth.forEach(d=>{
            chartData[d[0]-1].trips = d[1];
        });
        // console.log(chartData);

        var containerID = "#trips-by-month-chart-div";
        var container = $(containerID);
        container.empty();

        const chartColor = '#00A896';
        const chartColorHover = '#007569';
        var margin = { top: 20, right: 20, bottom: 30, left: 45 };
        var width = container.width() - margin.left - margin.right;
        var height = container.height() - margin.top - margin.bottom;

        var svg = d3.select(containerID)
            .append('svg')
            .attr('class', 'line-chart-svg')
            .attr("width", width + margin.left + margin.right)
            .attr("height", height + margin.top + margin.bottom);
    
        var x = d3.scaleBand().rangeRound([0, width]).padding(0.1),
            y = d3.scaleLinear().rangeRound([height, 0]);
        
        var g = svg.append("g")
            .attr('class', 'canvas-element')
            .attr("transform", "translate(" + margin.left + "," + margin.top + ")");

        x.domain(chartData.map(function(d) { return d.month; }));
        y.domain([0, d3.max(chartData, function(d) { return d.trips; })]);

        g.append("g")
            .attr("class", "axis axis--x")
            .attr("transform", "translate(0," + height + ")")
            .call(d3.axisBottom(x));
    
        g.append("g")
            .attr("class", "axis axis--y")
            .call(d3.axisLeft(y).ticks(2));
        
        g.selectAll(".bar")
            .data(chartData)
            .enter().append("rect")
            .attr("class", "bar")
            .attr("x", function(d) { return x(d.month); })
            .attr("y", function(d) { return y(d.trips); })
            .attr("width", x.bandwidth())
            .attr("height", function(d) { return height - y(d.trips); })
            .style("fill", chartColor)
            .on("mouseover", function(d){
                let tooltipTxt = numberWithCommas(d.trips);
                d3.select(this).style("fill", chartColorHover);
                $('.trips-by-month-val').text(tooltipTxt);
            })
            .on("mouseout", function(d){
                $('.trips-by-month-val').text('');
                d3.select(this).style("fill", chartColor);
            });
    }

    function drawDonutChartForPaymentType(){
        var containerID = "#payment-chart-div";
        var container = $(containerID);
        container.empty();

        const sum = app.paymentTypeData[0].value + app.paymentTypeData[1].value;
        const pctByCard = Math.round((app.paymentTypeData[0].value / sum) * 100);
        const pctByCash = Math.round((app.paymentTypeData[1].value / sum) * 100);

        var width = container.width() * .9;
        var height = container.height() * .9;;
        var radius = Math.min(width, height) / 2;

        var svg = d3.select(containerID)
            .append('svg')
            .attr('width', width)
            .attr('height', height)
            .append('g')
            .attr('transform', 'translate(' + (width / 2) + ',' + (height / 2) + ')');
        
        var donutWidth = 75;

        var arc = d3.arc()
            .innerRadius(radius * 0.6)
            .outerRadius(radius);

        var pie = d3.pie()
            .sort(null)
            .value(function(d) { return d.value; });

        var g = svg.selectAll(".arc")
            .data(pie(app.paymentTypeData))
            .enter().append("g")
            .attr("class", "arc");
      
        g.append("path")
            .attr("d", arc)
            .style("fill", function(d) { 
                let color = (d.data.key === 'sum_of_payment_by_card') ? '#98abc5' : '#8a89a6'
                return color; 
            });

        $('.payment-by-card-val').text(pctByCard + '%');
        $('.payment-by-cash-val').text(pctByCash + '%');
    }

    function getHighlightHexagonStyle(){
        var symbol = new SimpleFillSymbol(
            SimpleFillSymbol.STYLE_SOLID,
            new SimpleLineSymbol(SimpleLineSymbol.STYLE_NULL, new Color([0, 0, 0, 0]), 0),
            new Color([255, 255, 255, 0.7])
        );
        return symbol;
    }

    function getMaxValue(data, field){
        return d3.max(data, function(d){return d.properties[field]; });
    }

    function getRange(data, field){
        var range = [];
        var lookup = {};
        
        data.forEach(d=>{
            if(d.properties[field]){
                if(!lookup[d.properties[field]]){
                    range.push(d.properties[field]);
                    lookup[d.properties[field]] = true;
                }
            }
        });

        range.sort(function(a, b) {
            return a - b;
        });
        // console.log('range', range)
        return range;
    }

    function sort_by(field, reverse, primer){

        var key = primer ? 
            function(x) {return primer(x[field])} : 
            function(x) {return x[field]};

        reverse = !reverse ? 1 : -1;

        return function (a, b) {
            return a = key(a), b = key(b), reverse * ((a > b) - (b > a));
        } 
    }

    function round(value, decimals) {
        return Number(Math.round(value + 'e' + decimals) + 'e-' + decimals);
    }

    function numberWithCommas(x) {
        return x.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    }

    function toggleLoadingIndicator(isVisible){
        if(isVisible){
            $(document.body).addClass("app-loading");
        } else {
            $(document.body).removeClass("app-loading");
        }
    }

    function getTripType(){
        var checkedItem = $(".checkbox-trip-type").find(".fa-check-square-o");
        var tripType = checkedItem.parent().attr("trip-type");
        return tripType;
    }

    function getCosines(){
        var cosines = [];
        for (var i = 0; i < 6; i++) {
            var angle = 2 * Math.PI / 6 * i;
            cosines.push(Math.cos(angle));
        }
        return cosines;
    }

    function getSines(){
        var sines = [];
        for (var i = 0; i < 6; i++) {
            var angle = 2 * Math.PI / 6 * i;
            sines.push(Math.sin(angle));
        }
        return sines;
    }

    function getHexagonColor(index, tripType){
        const color = (tripType === 'pickup') ? FILL_COLOR_FOR_PICKUP[index] : FILL_COLOR_FOR_DROPOFF[index];
        const defaultColor = (tripType === 'pickup') ? FILL_COLOR_FOR_PICKUP[1] : FILL_COLOR_FOR_DROPOFF[1];
        return color ? color : defaultColor;
    }

    function showSummaryInfoWindow(feature, evt){
        var tripType = getTripType();
        var summaryInfoDiv = $('.summary-info');
        if(feature){
            var attributes = {
                count_of_trips: feature.properties.count_of_trips,
                avg_of_duration_in_min: round(feature.properties.avg_of_duration_in_min, 0),
                avg_of_costs: round(feature.properties.avg_of_costs, 0),
                avg_of_passengers: round(feature.properties.avg_of_passengers,1),
                pct_of_tips: round(feature.properties.pct_of_tips * 100,0),
                pct_of_payment_by_card: round(feature.properties.pct_of_payment_by_card * 100,0),
                pct_of_payment_by_cash: round(feature.properties.pct_of_payment_by_cash * 100,0),
            };
            // var geom = new Point( {"x": feature.geometry.coordinates[0], "y": feature.geometry.coordinates[1], "spatialReference": {"wkid": 4326 } });
            var descOfTripType = (tripType === 'pickup') ? ' to here from the selected location' : 'from here to selected location'
            var infoTemplateContent = `
                <b>${numberWithCommas(attributes.count_of_trips)}</b> Rides ${(!app.selectedHexGridId) ? '' : descOfTripType}<br>
                <b>${attributes.avg_of_passengers}</b> passengers, <b>${attributes.avg_of_duration_in_min}</b> minute ride<br>
                <b>$${attributes.avg_of_costs}</b> fare, plus <b>${attributes.pct_of_tips}%</b> tips<br>
                <b>${attributes.pct_of_payment_by_card}%</b> paid with credit, <b>${attributes.pct_of_payment_by_cash}%</b> with cash
            `;
            summaryInfoDiv.html(infoTemplateContent);
            summaryInfoDiv.removeClass('hide');
        } else {
            summaryInfoDiv.addClass('hide');
        }
    }

    function populateLegend(quantilesSize, quantilesColor, fieldName){
        const $legendContainer = $('.legend-container');
        const tripType = getTripType();
        const color = (tripType === 'pickup') ? FILL_COLOR_FOR_PICKUP : FILL_COLOR_FOR_DROPOFF;
        const isPctField = (fieldName === 'pct_of_tips' || fieldName === 'pct_of_payment_by_card' || fieldName === 'pct_of_payment_by_cash') ? true : false;

        if(isPctField){
            quantilesColor = quantilesColor.map(function(d){
                return isPctField ? d * 100 : d;
            });
        }

        const svgLookup = [
            '<svg version="1.1" xmlns="http://www.w3.org/2000/svg" width="8" height="7" viewbox="0 0 8 6.928203230275509" style="filter: drop-shadow(rgba(255, 255, 255, 0.5) 0px 0px 10px);"><path fill="#ddd" d="M0 3.4641016151377544L2 0L6 0L8 3.4641016151377544L6 6.928203230275509L2 6.928203230275509Z"></path></svg>',
            '<svg version="1.1" xmlns="http://www.w3.org/2000/svg" width="12" height="11" viewbox="0 0 12 10.392304845413264" style="filter: drop-shadow(rgba(255, 255, 255, 0.5) 0px 0px 10px);"><path fill="#ddd" d="M0 5.196152422706632L3 0L9 0L12 5.196152422706632L9 10.392304845413264L3 10.392304845413264Z"></path></svg>',
            '<svg version="1.1" xmlns="http://www.w3.org/2000/svg" width="16" height="14" viewbox="0 0 16 13.856406460551018" style="filter: drop-shadow(rgba(255, 255, 255, 0.5) 0px 0px 10px);"><path fill="#ddd" d="M0 6.928203230275509L4 0L12 0L16 6.928203230275509L12 13.856406460551018L4 13.856406460551018Z"></path></svg>',
            '<svg version="1.1" xmlns="http://www.w3.org/2000/svg" width="24" height="21" viewbox="0 0 24 20.784609690826528" style="filter: drop-shadow(rgba(255, 255, 255, 0.5) 0px 0px 10px);"><path fill="#ddd" d="M0 10.392304845413264L6 0L18 0L24 10.392304845413264L18 20.784609690826528L6 20.784609690826528Z"></path></svg>',
            '<svg version="1.1" xmlns="http://www.w3.org/2000/svg" width="32" height="28" viewbox="0 0 32 27.712812921102035" style="filter: drop-shadow(rgba(255, 255, 255, 0.5) 0px 0px 10px);"><path fill="#ddd" d="M0 13.856406460551018L8 0L24 0L32 13.856406460551018L24 27.712812921102035L8 27.712812921102035Z"></path></svg>',
        ];

        let sizeLegends = quantilesSize.map(function(d, i){
            const svg = svgLookup[i];
            let labelTxt = numberWithCommas(round(d, 0));
            if(i === 0) {
                labelTxt += ' and less';
            } else if(i === quantilesSize.length - 1){
                labelTxt += '+';
            }
            return '<div class="size-info"><div class="inline-block text-center">' + svg + '</div> <span class="legend-label right margin-left-half">' + labelTxt + '</span></div>';
        });
        sizeLegends.unshift('<div class="legend-title"><span class="avenir-bold">Total Rides</span></div>');
        sizeLegends.push('<hr>')

        let colorLegends = quantilesColor.map(function(d, i){
            let decimalPlace = quantilesColor[quantilesColor.length - 1] - quantilesColor[0] <= 2 ? 1 : 0;
            let labelTxt = isPctField ?  numberWithCommas(round(d, decimalPlace)) + '%' : numberWithCommas(round(d, decimalPlace));
            if(i === 0) {
                labelTxt += ' and less';
            } else if(i === quantilesColor.length - 1){
                labelTxt += '+';
            }
            let hrmlStr = '<div class="legend-item color-info-' + i + '"><span class="legend-label">' + labelTxt + '</span></div>';
            return hrmlStr;
        });
        const colorInfoTitle = $('.select-attr-to-display option[value="' + fieldName + '"]').text();
        colorLegends.unshift('<div class="legend-title"><span class="avenir-bold">' + colorInfoTitle + '</span></div>');

        const legends = sizeLegends.concat(colorLegends);

        $legendContainer.removeClass('pickup');
        $legendContainer.removeClass('dropoff');
        $legendContainer.addClass(tripType);
        $legendContainer.html(legends.join(''));
    }

    //add event listeners
    $(".checkbox-trip-type").on("click", (evt)=>{
        var target = $(evt.currentTarget);
        var checkboxIcon = target.find(".fa");
        var siblingCheckboxIcon = target.siblings().find(".fa");
        checkboxIcon.toggleClass("fa-check-square-o fa-square-o");
        siblingCheckboxIcon.toggleClass("fa-check-square-o fa-square-o");
        redrawHexGridLayer();
    });

    $(".select-menu-options.radio-btns > div").on("click", (evt)=>{
        var target = $(evt.currentTarget);
        var siblingOptions = target.siblings();
        siblingOptions.removeClass("active");
        target.addClass("active");
    });

    $('.select-attr-to-display').on('change', (evt)=>{
        redrawHexGridLayer();
    });


});