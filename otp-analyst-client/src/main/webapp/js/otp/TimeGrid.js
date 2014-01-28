/* This program is free software: you can redistribute it and/or
   modify it under the terms of the GNU Lesser General Public License
   as published by the Free Software Foundation, either version 3 of
   the License, or (at your option) any later version.
   
   This program is distributed in the hope that it will be useful,
   but WITHOUT ANY WARRANTY; without even the implied warranty of
   MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
   GNU General Public License for more details.
   
   You should have received a copy of the GNU General Public License
   along with this program.  If not, see <http://www.gnu.org/licenses/>. 
 */

var OTPA = OTPA || {}; // namespace

/**
 * TimeGrid class (from PNG data).
 */

/**
 * Factory method.
 */
OTPA.timeGrid = function(requestParams, callback) {
    return new OTPA.TimeGrid(requestParams, callback);
};

/**
 * Constructor.
 */
OTPA.TimeGrid = function(requestParams, callback) {
    // We do the base64 encoding on the server as
    // doing it on the client is painful and not portable.
    var url = '/otp-rest-servlet/ws/timegrid?' + $.param(requestParams)
            + "&base64=true";
    var thisTg = this;
    this.precisionMeters = requestParams.precisionMeters;
    $.ajax({
        url : url,
        async : true,
        mimeType : "image/png",
        // dataFilter : function(data, type) {
        // return window.btoa(data); <-- JS is really dumb
        // },
        success : function(data, textStatus, jqXhr) {
            var xy = jqXhr.getResponseHeader("OTPA-Grid-Corner").split(",");
            thisTg.gridBase = L.latLng(xy[0], xy[1]);
            xy = jqXhr.getResponseHeader("OTPA-Grid-Cell-Size").split(",");
            thisTg.cellSize = L.latLng(xy[0], xy[1]);
            thisTg.offRoadDistanceMeters = jqXhr
                    .getResponseHeader("OTPA-OffRoad-Dist");
            var png = new Image();
            png.onload = function() {
                var canvas = document.createElement("canvas");
                canvas.width = png.width;
                canvas.height = png.height;
                var ctx = canvas.getContext("2d");
                ctx.drawImage(png, 0, 0);
                thisTg.timeGrid = ctx.getImageData(0, 0, canvas.width,
                        canvas.height);
                thisTg.channels = 4; // RGBA
                callback(thisTg);
            }
            png.src = "data:image/png;base64," + data;
        }
    });
    // Init tile cache
    this.cachedX = null;
    this.cachedY = null;
    this.cachedV00 = null;
    this.cachedV01 = null;
    this.cachedV10 = null;
    this.cachedV11 = null;
};

/**
 * Return the interpolated values for a given coordinate (lat/lon).
 * 
 * The returned object contains the following values: t (time in seconds), d
 * (off-road distance in meters). Return null if the point is not within the
 * time grid area (either outside of the grid, or with an interpolated off-road
 * value greater than the max offroad distance).
 */
OTPA.TimeGrid.prototype.get = function(latLng) {
    var xIndex = Math.round((latLng.lng - this.gridBase.lng)
            / this.cellSize.lng - 0.5);
    var yIndex = Math.round((latLng.lat - this.gridBase.lat)
            / this.cellSize.lat - 0.5);
    var Vxx = null;
    if (xIndex != this.cachedX || yIndex != this.cachedY) {
        this.cachedX = xIndex;
        this.cachedY = yIndex;
        this.cachedV00 = this._getValues(xIndex, yIndex);
        this.cachedV10 = this._getValues(xIndex + 1, yIndex);
        this.cachedV01 = this._getValues(xIndex, yIndex + 1);
        this.cachedV11 = this._getValues(xIndex + 1, yIndex + 1);
    }
    if (this.cachedV00 == null || this.cachedV10 == null
            || this.cachedV01 == null || this.cachedV11 == null)
        return null;
    var kx = (latLng.lng - this.cachedV00.c.lng) / this.cellSize.lng;
    var ky = (latLng.lat - this.cachedV00.c.lat) / this.cellSize.lat;
    var d0 = this.cachedV00.d * (1 - ky) + this.cachedV01.d * ky;
    var d1 = this.cachedV10.d * (1 - ky) + this.cachedV11.d * ky;
    var d = d0 * (1 - kx) + d1 * kx;
    if (d > this.offRoadDistanceMeters)
        return null;
    var t0 = this.cachedV00.t * (1 - ky) + this.cachedV01.t * ky;
    var t1 = this.cachedV10.t * (1 - ky) + this.cachedV11.t * ky;
    var t = t0 * (1 - kx) + t1 * kx;
    return {
        t : t,
        d : d,
        // TODO Remove this, debug only
        a : this.cachedV00.c,
        b : this.cachedV01.c,
        c : this.cachedV10.c,
        d : this.cachedV11.c
    };
};

/**
 * Return the values for a given (x,y) index.
 */
OTPA.TimeGrid.prototype._getValues = function(xIndex, yIndex) {
    if (xIndex < 0 || yIndex < 0 || xIndex >= this.timeGrid.width
            || yIndex >= this.timeGrid.height)
        return null;
    var offset = (xIndex + yIndex * this.timeGrid.width) * this.channels;
    var r = this.timeGrid.data[offset];
    var g = this.timeGrid.data[offset + 1];
    var b = this.timeGrid.data[offset + 2];
    var a = this.timeGrid.data[offset + 3];
    if (a == 0)
        return null;
    var lng = xIndex * this.cellSize.lng + this.gridBase.lng;
    var lat = yIndex * this.cellSize.lat + this.gridBase.lat;
    return {
        t : r + (g << 8),
        d : b / 100 * this.precisionMeters,
        c : {
            lng : lng,
            lat : lat
        }
    };
};

/**
 * Create a leaflet canvas layer for the given timeGrid.
 * 
 * @param timeGrid
 *            Any object with a get(latLng) method which retreive a value for a
 *            given lat/lon coordinate.
 * @param colorMap
 *            A mapper between value and color, with a defined value range.
 * @return A canvas-tiled leaflet layer, with a additional refresh() method to
 *         be called when the colorMap has been modified.
 */
OTPA.getLeafletLayer = function(timeGrid, colorMap) {
    var layer = new L.TileLayer.Canvas({
        async : true
    });
    layer.tileCache = [];
    layer.drawTile = function(canvas, tile, zoom) {
        var map = this._map; // Hackish
        var tileSize = this.options.tileSize;
        // Start coordinate in pixel
        var start = tile.multiplyBy(tileSize);
        var mtile = {
            width : tileSize,
            height : tileSize,
            x : tile.x,
            y : tile.y,
            z : zoom,
            // We do the point projection ourselves based on a
            // linear interpolation of tile corner projections.
            // This is an approximation for large tiles, but is much faster.
            northWest : map.unproject([ start.x, start.y ]),
            southEast : map
                    .unproject([ start.x + tileSize, start.y + tileSize ])
        };
        var thisLayer = this;
        OTPA._drawTile(timeGrid, this.tileCache, canvas, mtile, colorMap,
                function() {
                    thisLayer.tileDrawn(canvas);
                });
    };
    // Add a new method to the layer
    layer.refresh = function() {
        this.tileCache = [];
        this.redraw();
    }
    return layer;
};

/**
 * Generic tile drawing.
 * 
 * @param timeGrid
 *            The timeGrid to draw the tile for.
 * @param tileCache
 *            Tile cache array, containing cached PNG image of the tile.
 * @param canvas
 *            HTML5 canvas to draw into.
 * @param tile
 *            Tile, containing width, height, northWest, southEast (corners), x,
 *            y, z (tile position)
 * @param colorMap
 *            A mapping between values and color. Contains the range.
 * @param completionCallback
 *            Tile drawn completion callback, null if synchronous.
 */
OTPA._drawTile = function(timeGrid, tileCache, canvas, tile, colorMap,
        completionCallback) {
    var context = canvas.getContext("2d");
    var cachedTile = tileCache[[ tile.x, tile.y, tile.z ]];
    if (cachedTile != null) {
        context.drawImage(cachedTile, 0, 0);
        if (completionCallback)
            completionCallback();
        return cachedTile;
    }
    // Else start a timer function to paint
    var drawFunc = function() {
        var id = context.createImageData(tile.width, tile.height);
        var d = id.data;
        var dLat = tile.southEast.lat - tile.northWest.lat;
        var dLng = tile.southEast.lng - tile.northWest.lng;
        var dxy = 4; // Should be a divisor of tile.width & tile.height
        var paint = function(x, y) {
            var C = L.latLng(tile.northWest.lat + y * dLat / tile.height,
                    tile.northWest.lng + x * dLng / tile.width);
            var v = timeGrid.get(C);
            if (v != null) {
                var color = colorMap.colorize(v.t);
                if (color != null) {
                    var j = (x + y * tile.width) * 4;
                    d[j++] = (color & 0xFF0000) >> 16;
                    d[j++] = (color & 0x00FF00) >> 8;
                    d[j++] = (color & 0x0000FF);
                    d[j++] = 255; // Use leaflet transparency
                    return color;
                }
            }
            return -1;
        }
        var getColor = function(x, y) {
            var j = (x + y * tile.width) * 4;
            if (d[j + 3] == 0)
                return -1;
            return (d[j] << 16) + (d[j + 1] << 8) + (d[j + 2]);
        }
        for (var x = 0; x < tile.width; x++) {
            paint(x, 0);
        }
        for (var y = 0; y < tile.height; y++) {
            paint(0, y);
        }
        for (var x = dxy - 1; x < tile.width; x += dxy) {
            for (var y = dxy - 1; y < tile.height; y += dxy) {
                var xm = x - dxy;
                var ym = y - dxy;
                // First row/column is shorter
                if (xm < 0)
                    xm = 0;
                if (ym < 0)
                    ym = 0;
                var c1 = paint(x, y);
                var c2 = getColor(xm, y);
                var c3 = getColor(x, ym);
                var c4 = getColor(xm, ym);
                if (c1 == c2 && c2 == c3 && c3 == c4) {
                    if (c1 == -1) {
                        // Do nothing, outside area
                    } else {
                        // Note: we repaint 4 pixels, do not care
                        // This part of the code is critical in
                        // term of speed
                        var r = (c1 & 0xFF0000) >> 16;
                        var g = (c1 & 0x00FF00) >> 8;
                        var b = (c1 & 0x0000FF);
                        var j = (xm + 1 + (ym + 1) * tile.width) * 4;
                        for (var y2 = ym + 1; y2 <= y; y2++) {
                            for (var x2 = xm + 1; x2 <= x; x2++) {
                                d[j++] = r;
                                d[j++] = g;
                                d[j++] = b;
                                d[j++] = 255; // Use leaflet transparency
                            }
                            j += (tile.width + xm - x) * 4;
                        }
                    }
                } else {
                    for (var x2 = xm + 1; x2 <= x; x2++) {
                        for (var y2 = ym + 1; y2 <= y; y2++) {
                            paint(x2, y2);
                        }
                    }
                }
            }
        }
        context.putImageData(id, 0, 0);
        var img = new Image();
        img.src = canvas.toDataURL("image/png");
        tileCache[[ tile.x, tile.y, tile.z ]] = img;
        if (completionCallback)
            completionCallback();
    };
    if (completionCallback) {
        setTimeout(drawFunc, Math.floor((Math.random() * 100) + 1));
    } else {
        drawFunc();
        return tileCache[[ tile.x, tile.y, tile.z ]];
    }
};

/**
 * Build an image out of a time grid.
 */
OTPA.getImage = function(timeGrid, colorMap, options) {
    // Ensure divisible by 4
    options.height = Math.round(options.height / 4) * 4;
    options.width = Math.round(options.width / 4) * 4;
    var canvas = $("<canvas/>").get(0);
    canvas.width = options.width;
    canvas.height = options.height;
    options.x = 0;
    options.y = 0;
    options.z = 0;
    return OTPA._drawTile(timeGrid, [], canvas, options, colorMap, null);
};

/**
 * Return debug layers.
 * 
 * TODO: Remove this.
 */
OTPA.TimeGrid.prototype._getDebugLayer = function() {
    var retval = [];
    var dx = this.cellSize.lng;
    var dy = this.cellSize.lat;
    for (var x = 0; x < this.timeGrid.width; x++) {
        for (var y = 0; y < this.timeGrid.height; y++) {
            var v = this._getValues(x, y);
            if (v == null)
                continue;
            var color = "#00f";
            var radius = v.t / 1000000;
            if (v.d > this.offRoadDistanceMeters) {
                color = "#f00";
                radius = 600 / 1000000;
            }
            var coords = [];
            coords.push(L.latLng(v.c.lat + radius, v.c.lng + radius));
            coords.push(L.latLng(v.c.lat, v.c.lng));
            coords.push(L.latLng(v.c.lat - r2, v.c.lng));
            coords.push(L.latLng(v.c.lat + r2, v.c.lng));
            coords.push(L.latLng(v.c.lat, v.c.lng));
            coords.push(L.latLng(v.c.lat, v.c.lng - r2));
            coords.push(L.latLng(v.c.lat, v.c.lng + r2));
            retval.push(L.polyline(coords, {
                color : color,
                weight : 1
            }));
        }
    }
    return retval;
};

/**
 * TimeGridDiff class. Inherit TimeGrid.
 */

OTPA.timeGridDiff = function(timeGrid1, timeGrid2) {
    return new OTPA.TimeGridDiff(timeGrid1, timeGrid2);
};

/**
 * Constructor.
 */
OTPA.TimeGridDiff = function(timeGrid1, timeGrid2) {
    this.timeGrid1 = timeGrid1;
    this.timeGrid2 = timeGrid2;
};

/**
 * Return the values for a given (x,y) index.
 */
OTPA.TimeGridDiff.prototype.get = function(latLng) {
    var v1 = this.timeGrid1.get(latLng);
    var v2 = this.timeGrid2.get(latLng);
    if (v1 == null || v2 == null) {
        if (v1 == null && v2 == null) {
            return null;
        }
        if (v1 == null) {
            return {
                t : +1000000, // +inf
                d : v2.d
            };
        }
        return {
            t : -1000000, // -inf
            d : v1.d
        };
    }
    return {
        t : v1.t - v2.t,
        // Is this correct?
        d : Math.max(v1.d, v2.d)
    };
};
