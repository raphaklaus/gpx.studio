import { currentTool, Tool } from "$lib/stores";
import { settings, type GPXFileWithStatistics, dbUtils } from "$lib/db";
import { get, type Readable } from "svelte/store";
import mapboxgl from "mapbox-gl";
import { currentPopupWaypoint, deleteWaypoint, waypointPopup } from "./WaypointPopup";
import { addSelectItem, selectItem, selection } from "$lib/components/file-list/Selection";
import { ListTrackSegmentItem, ListWaypointItem, ListWaypointsItem, ListTrackItem, ListFileItem, ListRootItem } from "$lib/components/file-list/FileList";
import type { Waypoint } from "gpx";
import { resetCursor, setCursor, setGrabbingCursor, setPointerCursor } from "$lib/utils";
import { font } from "$lib/assets/layers";
import { selectedWaypoint } from "$lib/components/toolbar/tools/Waypoint.svelte";

const colors = [
    '#ff0000',
    '#0000ff',
    '#46e646',
    '#00ccff',
    '#ff9900',
    '#ff00ff',
    '#ffff32',
    '#288228',
    '#9933ff',
    '#50f0be',
    '#8c645a'
];

const colorCount: { [key: string]: number } = {};
for (let color of colors) {
    colorCount[color] = 0;
}

// Get the color with the least amount of uses
function getColor() {
    let color = colors.reduce((a, b) => (colorCount[a] <= colorCount[b] ? a : b));
    colorCount[color]++;
    return color;
}

function decrementColor(color: string) {
    if (colorCount.hasOwnProperty(color)) {
        colorCount[color]--;
    }
}

const { directionMarkers, verticalFileView, currentBasemap, defaultOpacity, defaultWeight } = settings;

export class GPXLayer {
    map: mapboxgl.Map;
    fileId: string;
    file: Readable<GPXFileWithStatistics | undefined>;
    layerColor: string;
    markers: mapboxgl.Marker[] = [];
    selected: boolean = false;
    draggable: boolean;
    unsubscribe: Function[] = [];

    updateBinded: () => void = this.update.bind(this);
    layerOnMouseEnterBinded: (e: any) => void = this.layerOnMouseEnter.bind(this);
    layerOnMouseLeaveBinded: () => void = this.layerOnMouseLeave.bind(this);
    layerOnClickBinded: (e: any) => void = this.layerOnClick.bind(this);
    maybeHideWaypointPopupBinded: (e: any) => void = this.maybeHideWaypointPopup.bind(this);

    constructor(map: mapboxgl.Map, fileId: string, file: Readable<GPXFileWithStatistics | undefined>) {
        this.map = map;
        this.fileId = fileId;
        this.file = file;
        this.layerColor = getColor();
        this.unsubscribe.push(file.subscribe(this.updateBinded));
        this.unsubscribe.push(selection.subscribe($selection => {
            let newSelected = $selection.hasAnyChildren(new ListFileItem(this.fileId));
            if (this.selected || newSelected) {
                this.selected = newSelected;
                this.update();
            }
            if (newSelected) {
                this.moveToFront();
            }
        }));
        this.unsubscribe.push(directionMarkers.subscribe(this.updateBinded));
        this.unsubscribe.push(currentTool.subscribe(tool => {
            if (tool === Tool.WAYPOINT && !this.draggable) {
                this.draggable = true;
                this.markers.forEach(marker => marker.setDraggable(true));
            } else if (tool !== Tool.WAYPOINT && this.draggable) {
                this.draggable = false;
                this.markers.forEach(marker => marker.setDraggable(false));
            }
        }));
        this.draggable = get(currentTool) === Tool.WAYPOINT;

        this.map.on('style.load', this.updateBinded);
    }

    update() {
        let file = get(this.file)?.file;
        if (!file) {
            return;
        }

        if (file._data.style && file._data.style.color && this.layerColor !== file._data.style.color) {
            decrementColor(this.layerColor);
            this.layerColor = file._data.style.color;
        }

        try {
            let source = this.map.getSource(this.fileId);
            if (source) {
                source.setData(this.getGeoJSON());
            } else {
                this.map.addSource(this.fileId, {
                    type: 'geojson',
                    data: this.getGeoJSON()
                });
            }

            if (!this.map.getLayer(this.fileId)) {
                this.map.addLayer({
                    id: this.fileId,
                    type: 'line',
                    source: this.fileId,
                    layout: {
                        'line-join': 'round',
                        'line-cap': 'round'
                    },
                    paint: {
                        'line-color': ['get', 'color'],
                        'line-width': ['get', 'weight'],
                        'line-opacity': ['get', 'opacity']
                    }
                });

                this.map.on('click', this.fileId, this.layerOnClickBinded);
                this.map.on('mouseenter', this.fileId, this.layerOnMouseEnterBinded);
                this.map.on('mouseleave', this.fileId, this.layerOnMouseLeaveBinded);
            }

            if (get(directionMarkers)) {
                if (!this.map.getLayer(this.fileId + '-direction')) {
                    this.map.addLayer({
                        id: this.fileId + '-direction',
                        type: 'symbol',
                        source: this.fileId,
                        layout: {
                            'text-field': '»',
                            'text-offset': [0, -0.1],
                            'text-keep-upright': false,
                            'text-max-angle': 361,
                            'text-allow-overlap': true,
                            'text-font': [font[get(currentBasemap)] ?? 'Open Sans Bold'],
                            'symbol-placement': 'line',
                            'symbol-spacing': 20,
                        },
                        paint: {
                            'text-color': 'white',
                            'text-opacity': 0.7,
                            'text-halo-width': 0.2,
                            'text-halo-color': 'white'
                        }
                    }, this.map.getLayer('distance-markers') ? 'distance-markers' : undefined);
                }
            } else {
                if (this.map.getLayer(this.fileId + '-direction')) {
                    this.map.removeLayer(this.fileId + '-direction');
                }
            }

            let visibleItems: [number, number][] = [];
            file.forEachSegment((segment, trackIndex, segmentIndex) => {
                if (!segment._data.hidden) {
                    visibleItems.push([trackIndex, segmentIndex]);
                }
            });

            this.map.setFilter(this.fileId, ['any', ...visibleItems.map(([trackIndex, segmentIndex]) => ['all', ['==', 'trackIndex', trackIndex], ['==', 'segmentIndex', segmentIndex]])], { validate: false });
        } catch (e) { // No reliable way to check if the map is ready to add sources and layers
            return;
        }

        let markerIndex = 0;

        if (get(selection).hasAnyChildren(new ListFileItem(this.fileId))) {
            file.wpt.forEach((waypoint) => { // Update markers
                if (markerIndex < this.markers.length) {
                    this.markers[markerIndex].setLngLat(waypoint.getCoordinates());
                    Object.defineProperty(this.markers[markerIndex], '_waypoint', { value: waypoint, writable: true });
                } else {
                    let marker = new mapboxgl.Marker({
                        draggable: this.draggable,
                        scale: 0.8
                    }).setLngLat(waypoint.getCoordinates());
                    Object.defineProperty(marker, '_waypoint', { value: waypoint, writable: true });
                    let dragEndTimestamp = 0;
                    marker.getElement().addEventListener('mouseover', (e) => {
                        if (marker._isDragging) {
                            return;
                        }
                        this.showWaypointPopup(marker._waypoint);
                        e.stopPropagation();
                    });
                    marker.getElement().addEventListener('click', (e) => {
                        if (dragEndTimestamp && Date.now() - dragEndTimestamp < 1000) {
                            return;
                        }

                        if (get(currentTool) === Tool.WAYPOINT && e.shiftKey) {
                            deleteWaypoint(this.fileId, marker._waypoint._data.index);
                            e.stopPropagation();
                            return;
                        }

                        if (get(verticalFileView)) {
                            if ((e.ctrlKey || e.metaKey) && get(selection).hasAnyChildren(new ListWaypointsItem(this.fileId), false)) {
                                addSelectItem(new ListWaypointItem(this.fileId, marker._waypoint._data.index));
                            } else {
                                selectItem(new ListWaypointItem(this.fileId, marker._waypoint._data.index));
                            }
                        } else if (get(currentTool) === Tool.WAYPOINT) {
                            selectedWaypoint.set([marker._waypoint, this.fileId]);
                        } else {
                            this.showWaypointPopup(marker._waypoint);
                        }
                        e.stopPropagation();
                    });
                    marker.on('dragstart', () => {
                        setGrabbingCursor();
                        marker.getElement().style.cursor = 'grabbing';
                        this.hideWaypointPopup();
                    });
                    marker.on('dragend', (e) => {
                        resetCursor();
                        marker.getElement().style.cursor = '';
                        dbUtils.applyToFile(this.fileId, (file) => {
                            let latLng = marker.getLngLat();
                            let wpt = file.wpt[marker._waypoint._data.index];
                            wpt.setCoordinates({
                                lat: latLng.lat,
                                lon: latLng.lng
                            });
                            wpt.ele = this.map.queryTerrainElevation([latLng.lng, latLng.lat], { exaggerated: false }) ?? 0;
                        });
                        dragEndTimestamp = Date.now()
                    });
                    this.markers.push(marker);
                }
                markerIndex++;
            });
        }

        while (markerIndex < this.markers.length) { // Remove extra markers
            this.markers.pop()?.remove();
        }

        this.markers.forEach((marker) => {
            if (!marker._waypoint._data.hidden) {
                marker.addTo(this.map);
            } else {
                marker.remove();
            }
        });
    }

    remove() {
        this.map.off('click', this.fileId, this.layerOnClickBinded);
        this.map.off('mouseenter', this.fileId, this.layerOnMouseEnterBinded);
        this.map.off('mouseleave', this.fileId, this.layerOnMouseLeaveBinded);
        this.map.off('style.load', this.updateBinded);

        if (this.map.getLayer(this.fileId + '-direction')) {
            this.map.removeLayer(this.fileId + '-direction');
        }
        if (this.map.getLayer(this.fileId)) {
            this.map.removeLayer(this.fileId);
        }
        if (this.map.getSource(this.fileId)) {
            this.map.removeSource(this.fileId);
        }

        this.markers.forEach((marker) => {
            marker.remove();
        });

        this.unsubscribe.forEach((unsubscribe) => unsubscribe());

        decrementColor(this.layerColor);
    }

    moveToFront() {
        if (this.map.getLayer(this.fileId)) {
            this.map.moveLayer(this.fileId);
        }
        if (this.map.getLayer(this.fileId + '-direction')) {
            this.map.moveLayer(this.fileId + '-direction', this.map.getLayer('distance-markers') ? 'distance-markers' : undefined);
        }
    }

    layerOnMouseEnter(e: any) {
        let trackIndex = e.features[0].properties.trackIndex;
        let segmentIndex = e.features[0].properties.segmentIndex;

        if (get(currentTool) === Tool.SCISSORS && get(selection).hasAnyParent(new ListTrackSegmentItem(this.fileId, trackIndex, segmentIndex))) {
            setCursor(`url('data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" version="1.1"><path d="M 3.200 3.200 C 0.441 5.959, 2.384 9.516, 7 10.154 C 10.466 10.634, 10.187 13.359, 6.607 13.990 C 2.934 14.637, 1.078 17.314, 2.612 19.750 C 4.899 23.380, 10 21.935, 10 17.657 C 10 16.445, 12.405 13.128, 15.693 9.805 C 18.824 6.641, 21.066 3.732, 20.674 3.341 C 20.283 2.950, 18.212 4.340, 16.072 6.430 C 12.019 10.388, 10 10.458, 10 6.641 C 10 2.602, 5.882 0.518, 3.200 3.200 M 4.446 5.087 C 3.416 6.755, 5.733 8.667, 7.113 7.287 C 8.267 6.133, 7.545 4, 6 4 C 5.515 4, 4.816 4.489, 4.446 5.087 M 14 14.813 C 14 16.187, 19.935 21.398, 20.667 20.667 C 21.045 20.289, 20.065 18.634, 18.490 16.990 C 15.661 14.036, 14 13.231, 14 14.813 M 4.446 17.087 C 3.416 18.755, 5.733 20.667, 7.113 19.287 C 8.267 18.133, 7.545 16, 6 16 C 5.515 16, 4.816 16.489, 4.446 17.087" stroke="black" stroke-width="1.2" fill="white" fill-rule="evenodd"/></svg>') 12 12, auto`);
        } else {
            setPointerCursor();
        }
    }

    layerOnMouseLeave() {
        resetCursor();
    }

    layerOnClick(e: any) {
        if (get(currentTool) === Tool.ROUTING && get(selection).hasAnyChildren(new ListRootItem(), true, ['waypoints'])) {
            return;
        }

        let trackIndex = e.features[0].properties.trackIndex;
        let segmentIndex = e.features[0].properties.segmentIndex;

        if (get(currentTool) === Tool.SCISSORS && get(selection).hasAnyParent(new ListTrackSegmentItem(this.fileId, trackIndex, segmentIndex))) {
            dbUtils.split(this.fileId, trackIndex, segmentIndex, { lat: e.lngLat.lat, lon: e.lngLat.lng });
            return;
        }

        let file = get(this.file)?.file;
        if (!file) {
            return;
        }

        let item = undefined;
        if (get(verticalFileView) && file.getSegments().length > 1) { // Select inner item
            item = file.children[trackIndex].children.length > 1 ? new ListTrackSegmentItem(this.fileId, trackIndex, segmentIndex) : new ListTrackItem(this.fileId, trackIndex);
        } else {
            item = new ListFileItem(this.fileId);
        }

        if (e.originalEvent.ctrlKey || e.originalEvent.metaKey) {
            addSelectItem(item);
        } else {
            selectItem(item);
        }
    }

    showWaypointPopup(waypoint: Waypoint) {
        if (get(currentPopupWaypoint) !== null) {
            this.hideWaypointPopup();
        }
        let marker = this.markers[waypoint._data.index];
        if (marker) {
            currentPopupWaypoint.set([waypoint, this.fileId]);
            marker.setPopup(waypointPopup);
            marker.togglePopup();
            this.map.on('mousemove', this.maybeHideWaypointPopupBinded);
        }
    }

    maybeHideWaypointPopup(e: any) {
        let waypoint = get(currentPopupWaypoint)?.[0];
        if (waypoint) {
            let marker = this.markers[waypoint._data.index];
            if (marker) {
                if (this.map.project(marker.getLngLat()).dist(this.map.project(e.lngLat)) > 100) {
                    this.hideWaypointPopup();
                }
            } else {
                this.hideWaypointPopup();
            }
        }
    }

    hideWaypointPopup() {
        let waypoint = get(currentPopupWaypoint)?.[0];
        if (waypoint) {
            let marker = this.markers[waypoint._data.index];
            marker?.getPopup()?.remove();
            currentPopupWaypoint.set(null);
            this.map.off('mousemove', this.maybeHideWaypointPopupBinded);
        }
    }

    getGeoJSON(): GeoJSON.FeatureCollection {
        let file = get(this.file)?.file;
        if (!file) {
            return {
                type: 'FeatureCollection',
                features: []
            };
        }

        let data = file.toGeoJSON();

        let trackIndex = 0, segmentIndex = 0;
        for (let feature of data.features) {
            if (!feature.properties) {
                feature.properties = {};
            }
            if (!feature.properties.color) {
                feature.properties.color = this.layerColor;
            }
            if (!feature.properties.weight) {
                feature.properties.weight = get(defaultWeight);
            }
            if (!feature.properties.opacity) {
                feature.properties.opacity = get(defaultOpacity);
            }
            if (get(selection).hasAnyParent(new ListTrackSegmentItem(this.fileId, trackIndex, segmentIndex)) || get(selection).hasAnyChildren(new ListWaypointsItem(this.fileId), true)) {
                feature.properties.weight = feature.properties.weight + 2;
                feature.properties.opacity = Math.min(1, feature.properties.opacity + 0.1);
            }
            feature.properties.trackIndex = trackIndex;
            feature.properties.segmentIndex = segmentIndex;

            segmentIndex++;
            if (segmentIndex >= file.trk[trackIndex].trkseg.length) {
                segmentIndex = 0;
                trackIndex++;
            }
        }
        return data;
    }
}