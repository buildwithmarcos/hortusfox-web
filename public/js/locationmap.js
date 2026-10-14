/**
 * Location map: draw the areas of a location and place its plants on them.
 *
 * Runs standalone (not part of the webpack bundle) and renders into the
 * #location-map element of the location page.
 */
(function() {
    'use strict';

    const SVG_NS = 'http://www.w3.org/2000/svg';
    const PIN_RADIUS = 30;
    const LABEL_SPACE = 36;
    const HANDLE_RADIUS = 16;
    const GRID = 10;
    const MIN_SIZE = 40;

    const FORMATS = { landscape: 600, square: 1000, portrait: 1400 };

    const TYPES = {
        bed: { w: 300, h: 160, round: false },
        lawn: { w: 400, h: 300, round: false },
        path: { w: 400, h: 50, round: false },
        water: { w: 160, h: 160, round: true },
        structure: { w: 200, h: 140, round: false }
    };

    let root = null;
    let baseUrl = '';
    let labels = {};
    let plants = [];
    let saved = null;
    let map = null;
    let editing = false;
    let dirty = false;
    let busy = false;
    let selection = [];
    let highlight = null;
    let drag = null;
    let twoFingers = false;
    let pressing = false;
    let barStale = false;

    let svg = null;
    let shapeElems = [];
    let pinElems = {};
    let selectionBar = null;

    function html(tag, attrs, children) {
        const elem = document.createElement(tag);

        Object.keys(attrs || {}).forEach(function(key) {
            if (key === 'text') {
                elem.textContent = attrs[key];
            } else if (key.substring(0, 2) === 'on') {
                elem.addEventListener(key.substring(2), attrs[key]);
            } else if (attrs[key] !== null && attrs[key] !== false) {
                elem.setAttribute(key, attrs[key] === true ? '' : attrs[key]);
            }
        });

        (children || []).forEach(function(child) {
            if (child) {
                elem.appendChild(child);
            }
        });

        return elem;
    }

    function svgElem(tag, attrs) {
        const elem = document.createElementNS(SVG_NS, tag);

        Object.keys(attrs || {}).forEach(function(key) {
            elem.setAttribute(key, attrs[key]);
        });

        return elem;
    }

    function clone(data) {
        return JSON.parse(JSON.stringify(data));
    }

    function clamp(value, min, max) {
        return Math.max(min, Math.min(max, value));
    }

    function snap(value) {
        return Math.round(value / GRID) * GRID;
    }

    function plantById(id) {
        return plants.find(function(plant) { return plant.id === id; }) || null;
    }

    function pinOf(id) {
        return map.pins.find(function(pin) { return pin.plant === id; }) || null;
    }

    function isShape(item) {
        return map.shapes.indexOf(item) !== -1;
    }

    function isSelected(item) {
        return selection.indexOf(item) !== -1;
    }

    function unplacedPlants() {
        return plants.filter(function(plant) { return pinOf(plant.id) === null; });
    }

    function isEmpty() {
        return (map.shapes.length === 0) && (map.pins.length === 0) && (!map.bg_url);
    }

    function post(path, fields) {
        const body = new FormData();

        Object.keys(fields).forEach(function(key) {
            body.append(key, fields[key]);
        });

        return fetch(baseUrl + path, { method: 'POST', body: body, credentials: 'same-origin' })
            .then(function(response) { return response.json(); })
            .then(function(response) {
                if (response.code !== 200) {
                    throw new Error(response.msg || labels.failed);
                }

                return response;
            });
    }

    function setDirty() {
        dirty = true;
    }

    /* Rendering */

    function render() {
        root.textContent = '';
        root.classList.toggle('is-editing', editing);

        const unplaced = unplacedPlants();

        const header = html('div', { class: 'location-map-header' }, [
            html('div', { class: 'location-map-title', text: labels.title })
        ]);

        if (!editing) {
            if ((!isEmpty()) && (unplaced.length > 0)) {
                header.appendChild(html('div', { class: 'location-map-note', text: labels.unplaced_count.replace('{count}', unplaced.length) }));
            }

            if (!isEmpty()) {
                header.appendChild(html('a', { class: 'button is-small', href: 'javascript:void(0);', text: labels.edit, onclick: startEditing }));
            }
        } else {
            header.appendChild(html('div', { class: 'location-map-actions' }, [
                html('a', { class: 'button is-small is-success' + (busy ? ' is-loading' : ''), href: 'javascript:void(0);', text: labels.save, onclick: save }),
                html('a', { class: 'button is-small', href: 'javascript:void(0);', text: labels.cancel, onclick: cancelEditing })
            ]));
        }

        root.appendChild(header);

        if ((!editing) && (isEmpty())) {
            root.appendChild(html('div', { class: 'location-map-empty' }, [
                html('div', { text: labels.empty }),
                html('a', { class: 'button is-success', href: 'javascript:void(0);', text: labels.create, onclick: startEditing })
            ]));

            return;
        }

        if (editing) {
            root.appendChild(renderToolbar());

            selectionBar = html('div', { class: 'location-map-selection' });
            root.appendChild(selectionBar);
            renderSelectionBar();
        }

        svg = svgElem('svg', { class: 'location-map-svg', viewBox: '0 0 ' + map.w + ' ' + map.h });
        svg.style.aspectRatio = map.w + ' / ' + map.h;

        if (editing) {
            svg.addEventListener('pointerdown', onPointerDown);
            svg.addEventListener('pointermove', onPointerMove);
            svg.addEventListener('pointerup', onPointerUp);
            svg.addEventListener('pointercancel', onPointerUp);

            svg.addEventListener('touchstart', onTouchStart, { passive: false });
            svg.addEventListener('touchmove', onTouchMove, { passive: false });
            svg.addEventListener('touchend', onTouchEnd);
            svg.addEventListener('touchcancel', onTouchEnd);
        }

        root.appendChild(html('div', { class: 'location-map-stage' }, [svg]));
        renderStage();

        if (editing) {
            root.appendChild(renderTray(unplaced));
        }
    }

    function renderToolbar() {
        const toolbar = html('div', { class: 'location-map-toolbar' });

        const areas = html('div', { class: 'location-map-group' }, [
            html('span', { class: 'location-map-group-label', text: labels.add_area })
        ]);

        Object.keys(TYPES).forEach(function(type) {
            areas.appendChild(html('a', { class: 'button is-small location-map-add', href: 'javascript:void(0);', onclick: function() { addShape(type); } }, [
                html('span', { class: 'location-map-swatch location-map-swatch-' + type }),
                html('span', { text: labels['type_' + type] })
            ]));
        });

        toolbar.appendChild(areas);

        const format = html('select', { onchange: function() { setHeight(parseInt(this.value)); } });
        let known = false;

        Object.keys(FORMATS).forEach(function(name) {
            known = known || (FORMATS[name] === map.h);
            format.appendChild(html('option', { value: FORMATS[name], text: labels['format_' + name], selected: FORMATS[name] === map.h }));
        });

        if (!known) {
            format.appendChild(html('option', { value: map.h, text: map.w + ' x ' + map.h, selected: true }));
        }

        const upload = html('input', { type: 'file', accept: 'image/png,image/jpeg,image/gif', class: 'is-hidden', onchange: function() {
            if (this.files.length > 0) {
                setBackground({ background: this.files[0] });
            }
        } });

        const settings = html('div', { class: 'location-map-group' }, [
            html('span', { class: 'location-map-group-label', text: labels.format }),
            html('div', { class: 'select is-small' }, [format]),
            html('label', { class: 'button is-small' + (busy ? ' is-loading' : '') }, [html('span', { text: labels.background }), upload]),
            (map.bg_url) ? html('a', { class: 'button is-small', href: 'javascript:void(0);', text: labels.background_remove, onclick: function() { setBackground({ remove: 1 }); } }) : null
        ]);

        toolbar.appendChild(settings);

        return toolbar;
    }

    function renderSelectionBar() {
        barStale = false;
        selectionBar.textContent = '';

        const item = (selection.length === 1) ? selection[0] : null;

        if ((item) && (isShape(item))) {
            const type = html('select', { onchange: function() {
                item.type = this.value;
                setDirty();
                renderStage();
            } });

            Object.keys(TYPES).forEach(function(name) {
                type.appendChild(html('option', { value: name, text: labels['type_' + name], selected: name === item.type }));
            });

            const round = html('input', { type: 'checkbox', checked: item.round, onchange: function() {
                item.round = this.checked;
                setDirty();
                renderStage();
            } });

            selectionBar.appendChild(html('input', { type: 'text', class: 'input is-small location-map-label-input', maxlength: 60, placeholder: labels.label, value: item.label, oninput: function() {
                item.label = this.value;
                setDirty();
                positionShape(map.shapes.indexOf(item));
            } }));
            selectionBar.appendChild(html('div', { class: 'select is-small' }, [type]));
            selectionBar.appendChild(html('label', { class: 'checkbox' }, [round, html('span', { text: ' ' + labels.round })]));
            selectionBar.appendChild(html('a', { class: 'button is-small', href: 'javascript:void(0);', text: labels.to_back, onclick: sendSelectedToBack }));
            selectionBar.appendChild(html('a', { class: 'button is-small is-danger', href: 'javascript:void(0);', text: labels.remove, onclick: removeSelected }));
        } else if (item) {
            const plant = plantById(item.plant);

            selectionBar.appendChild(html('strong', { text: (plant) ? plant.name : '' }));
            selectionBar.appendChild(html('a', { class: 'button is-small is-danger', href: 'javascript:void(0);', text: labels.remove_pin, onclick: removeSelected }));
        } else if (selection.length > 1) {
            selectionBar.appendChild(html('strong', { text: labels.selected_count.replace('{count}', selection.length) }));
            selectionBar.appendChild(html('a', { class: 'button is-small is-danger', href: 'javascript:void(0);', text: labels.remove, onclick: removeSelected }));
        } else {
            selectionBar.appendChild(html('span', { class: 'location-map-hint', text: labels.edit_hint }));
        }
    }

    function renderTray(unplaced) {
        const tray = html('div', { class: 'location-map-tray' }, [
            html('div', { class: 'location-map-tray-title', text: labels.unplaced + ' (' + unplaced.length + ')' })
        ]);

        if (unplaced.length > 0) {
            tray.appendChild(html('div', { class: 'location-map-hint', text: labels.unplaced_hint }));
        }

        const list = html('div', { class: 'location-map-tray-list' });

        unplaced.forEach(function(plant) {
            list.appendChild(html('a', { class: 'location-map-chip', href: 'javascript:void(0);', onclick: function() { placePlant(plant.id); } }, [
                html('img', { src: plant.photo, alt: '' }),
                html('span', { text: plant.name })
            ]));
        });

        tray.appendChild(list);

        return tray;
    }

    function renderStage() {
        svg.textContent = '';
        shapeElems = [];
        pinElems = {};

        const defs = svgElem('defs');
        const clip = svgElem('clipPath', { id: 'location-map-pin-clip' });
        clip.appendChild(svgElem('circle', { cx: 0, cy: 0, r: PIN_RADIUS }));
        defs.appendChild(clip);

        const grid = svgElem('pattern', { id: 'location-map-grid', width: GRID * 5, height: GRID * 5, patternUnits: 'userSpaceOnUse' });
        grid.appendChild(svgElem('path', { d: 'M ' + (GRID * 5) + ' 0 L 0 0 0 ' + (GRID * 5), class: 'location-map-gridline' }));
        defs.appendChild(grid);
        svg.appendChild(defs);

        svg.appendChild(svgElem('rect', { x: 0, y: 0, width: map.w, height: map.h, class: 'location-map-ground' }));

        if (map.bg_url) {
            svg.appendChild(svgElem('image', { x: 0, y: 0, width: map.w, height: map.h, href: map.bg_url, preserveAspectRatio: 'xMidYMid slice' }));
        }

        if (editing) {
            svg.appendChild(svgElem('rect', { x: 0, y: 0, width: map.w, height: map.h, fill: 'url(#location-map-grid)' }));
        }

        map.shapes.forEach(function(shape, index) {
            const group = svgElem('g', { class: 'location-map-shape location-map-shape-' + shape.type + (map.bg_url ? ' is-translucent' : ''), 'data-kind': 'shape', 'data-index': index });

            group.appendChild(svgElem('rect', { class: 'location-map-shape-body' }));
            group.appendChild(svgElem('text', { class: 'location-map-shape-label', 'text-anchor': 'middle', 'dominant-baseline': 'central' }));

            svg.appendChild(group);
            shapeElems[index] = group;
            decorateShape(index);
        });

        map.pins.forEach(function(pin) {
            const plant = plantById(pin.plant);
            if (!plant) {
                return;
            }

            const selected = (editing) && (isSelected(pin));
            const group = svgElem('g', { class: 'location-map-pin' + (selected ? ' is-selected' : '') + ((highlight === pin.plant) ? ' is-highlighted' : ''), 'data-kind': 'pin', 'data-plant': pin.plant });

            const title = svgElem('title');
            title.textContent = plant.name;
            group.appendChild(title);

            group.appendChild(svgElem('circle', { class: 'location-map-pin-pulse', cx: 0, cy: 0, r: PIN_RADIUS + 4 }));
            group.appendChild(svgElem('circle', { class: 'location-map-pin-ring', cx: 0, cy: 0, r: PIN_RADIUS + 4 }));
            group.appendChild(svgElem('image', { x: -PIN_RADIUS, y: -PIN_RADIUS, width: PIN_RADIUS * 2, height: PIN_RADIUS * 2, href: plant.photo, preserveAspectRatio: 'xMidYMid slice', 'clip-path': 'url(#location-map-pin-clip)' }));

            const label = svgElem('text', { class: 'location-map-pin-label', 'text-anchor': 'middle', y: PIN_RADIUS + LABEL_SPACE - 8 });
            label.textContent = (plant.name.length > 22) ? plant.name.substring(0, 21) + '…' : plant.name;
            group.appendChild(label);

            if (editing) {
                svg.appendChild(group);
            } else {
                const link = svgElem('a', { href: plant.url });
                link.appendChild(group);
                svg.appendChild(link);
            }

            pinElems[pin.plant] = group;
            positionPin(pin);
        });
    }

    function decorateShape(index) {
        const group = shapeElems[index];
        const selected = (editing) && (isSelected(map.shapes[index]));

        group.classList.toggle('is-selected', selected);

        group.querySelectorAll('.location-map-shape-outline, .location-map-handle').forEach(function(elem) {
            elem.remove();
        });

        if (selected) {
            group.appendChild(svgElem('rect', { class: 'location-map-shape-outline' }));

            // Resizing is only offered while a single area is selected
            if (selection.length === 1) {
                ['nw', 'ne', 'sw', 'se'].forEach(function(corner) {
                    group.appendChild(svgElem('circle', { class: 'location-map-handle location-map-handle-' + corner, r: HANDLE_RADIUS, 'data-kind': 'handle', 'data-corner': corner }));
                });
            }
        }

        positionShape(index);
    }

    function positionShape(index) {
        const shape = map.shapes[index];
        const group = shapeElems[index];

        if (!group) {
            return;
        }

        const body = group.querySelector('.location-map-shape-body');
        body.setAttribute('x', shape.x);
        body.setAttribute('y', shape.y);
        body.setAttribute('width', shape.w);
        body.setAttribute('height', shape.h);
        body.setAttribute('rx', (shape.round) ? shape.w / 2 : 8);
        body.setAttribute('ry', (shape.round) ? shape.h / 2 : 8);

        // Tall areas carry their label at the top so that plants placed inside do not cover it
        const fontSize = clamp(Math.min(shape.h * 0.6, shape.w / Math.max(4, shape.label.length) * 1.6), 14, 28);
        const label = group.querySelector('.location-map-shape-label');
        label.setAttribute('x', shape.x + shape.w / 2);
        label.setAttribute('y', ((shape.h >= 100) && (!shape.round)) ? shape.y + fontSize / 2 + 12 : shape.y + shape.h / 2);
        label.setAttribute('font-size', fontSize);
        label.textContent = shape.label;

        const outline = group.querySelector('.location-map-shape-outline');
        if (outline) {
            outline.setAttribute('x', shape.x);
            outline.setAttribute('y', shape.y);
            outline.setAttribute('width', shape.w);
            outline.setAttribute('height', shape.h);

            const corners = {
                nw: [shape.x, shape.y],
                ne: [shape.x + shape.w, shape.y],
                sw: [shape.x, shape.y + shape.h],
                se: [shape.x + shape.w, shape.y + shape.h]
            };

            Object.keys(corners).forEach(function(corner) {
                const handle = group.querySelector('.location-map-handle-' + corner);
                if (handle) {
                    handle.setAttribute('cx', corners[corner][0]);
                    handle.setAttribute('cy', corners[corner][1]);
                }
            });
        }
    }

    function positionPin(pin) {
        if (pinElems[pin.plant]) {
            pinElems[pin.plant].setAttribute('transform', 'translate(' + pin.x + ' ' + pin.y + ')');
        }
    }

    /* Editing */

    function startEditing() {
        editing = true;
        selection = [];
        highlight = null;
        render();
    }

    function cancelEditing() {
        if ((dirty) && (!confirm(labels.unsaved))) {
            return;
        }

        map = clone(saved);
        editing = false;
        dirty = false;
        selection = [];
        render();
    }

    function save() {
        if (busy) {
            return;
        }

        busy = true;
        render();

        post('/save', { data: JSON.stringify({ h: map.h, shapes: map.shapes, pins: map.pins }) })
            .then(function(response) {
                saved = response.map;
                map = clone(saved);
                editing = false;
                dirty = false;
                selection = [];
            })
            .catch(function(error) {
                alert(labels.failed + ': ' + error.message);
            })
            .finally(function() {
                busy = false;
                render();
            });
    }

    function setBackground(fields) {
        if (busy) {
            return;
        }

        busy = true;
        render();

        post('/background', fields)
            .then(function(response) {
                // The background is stored right away, independent of saving the layout
                saved.bg_url = response.bg_url;
                map.bg_url = response.bg_url;
            })
            .catch(function(error) {
                alert(error.message);
            })
            .finally(function() {
                busy = false;
                render();
            });
    }

    function setHeight(height) {
        map.h = height;

        map.shapes.forEach(function(shape) {
            shape.h = Math.min(shape.h, map.h);
            shape.y = clamp(shape.y, 0, map.h - shape.h);
        });

        map.pins.forEach(function(pin) {
            pin.y = clamp(pin.y, 0, map.h);
        });

        setDirty();
        render();
    }

    function addShape(type) {
        const preset = TYPES[type];
        const count = map.shapes.filter(function(shape) { return shape.type === type; }).length;
        const offset = (map.shapes.length % 8) * GRID * 2;
        const height = Math.min(preset.h, map.h);

        map.shapes.push({
            type: type,
            round: preset.round,
            x: clamp(snap((map.w - preset.w) / 2 + offset), 0, map.w - preset.w),
            y: clamp(snap((map.h - height) / 2 + offset), 0, map.h - height),
            w: preset.w,
            h: height,
            label: labels['type_' + type] + ' ' + (count + 1)
        });

        selection = [map.shapes[map.shapes.length - 1]];
        setDirty();
        render();
    }

    function placePlant(id) {
        if ((pinOf(id)) || (!plantById(id))) {
            return;
        }

        // Start inside the selected area, otherwise in the middle of the map
        let cx = map.w / 2;
        let cy = map.h / 2;

        if ((selection.length === 1) && (isShape(selection[0]))) {
            const shape = selection[0];
            cx = shape.x + shape.w / 2;
            cy = shape.y + shape.h / 2;
        }

        // Walk outwards in a spiral until the pin does not cover another one
        let x = cx;
        let y = cy;

        for (let step = 0; step < 200; step++) {
            const angle = step * 0.9;
            const distance = step * PIN_RADIUS * 0.35;

            x = clamp(cx + Math.cos(angle) * distance, PIN_RADIUS, map.w - PIN_RADIUS);
            y = clamp(cy + Math.sin(angle) * distance, PIN_RADIUS, map.h - PIN_RADIUS - LABEL_SPACE);

            const free = map.pins.every(function(pin) {
                return Math.hypot(pin.x - x, pin.y - y) > PIN_RADIUS * 2.2;
            });

            if (free) {
                break;
            }
        }

        map.pins.push({ plant: id, x: Math.round(x), y: Math.round(y) });

        selection = [pinOf(id)];
        setDirty();
        render();
    }

    function removeSelected() {
        if (selection.length === 0) {
            return;
        }

        map.shapes = map.shapes.filter(function(shape) { return !isSelected(shape); });
        map.pins = map.pins.filter(function(pin) { return !isSelected(pin); });

        selection = [];
        setDirty();
        render();
    }

    function sendSelectedToBack() {
        const shape = selection[0];

        map.shapes.splice(map.shapes.indexOf(shape), 1);
        map.shapes.unshift(shape);

        setDirty();
        render();
    }

    function setSelection(items) {
        const same = (items.length === selection.length) && (items.every(isSelected));
        if (same) {
            return;
        }

        selection = items;

        // Update in place: rebuilding the stage would remove the element under the
        // finger, which makes the browser cancel the touch that is about to drag it
        map.shapes.forEach(function(shape, index) {
            decorateShape(index);
        });

        map.pins.forEach(function(pin) {
            if (pinElems[pin.plant]) {
                pinElems[pin.plant].classList.toggle('is-selected', isSelected(pin));
            }
        });

        // The bar changes its height with the selection, which would shift the map under the pointer
        if ((pressing) || (drag)) {
            barStale = true;
        } else {
            renderSelectionBar();
        }
    }

    function flushSelectionBar() {
        if ((barStale) && (!drag)) {
            renderSelectionBar();
        }
    }

    /**
     * Move items by the same distance, stopping all of them as soon as one reaches the edge
     */
    function moveItems(items, origins, dx, dy) {
        // Areas stay aligned to the grid, and plants moved along with them keep their offset
        if (items.some(isShape)) {
            dx = snap(dx);
            dy = snap(dy);
        }

        let minX = -Infinity;
        let maxX = Infinity;
        let minY = -Infinity;
        let maxY = Infinity;

        origins.forEach(function(origin, index) {
            if (isShape(items[index])) {
                minX = Math.max(minX, -origin.x);
                maxX = Math.min(maxX, map.w - origin.w - origin.x);
                minY = Math.max(minY, -origin.y);
                maxY = Math.min(maxY, map.h - origin.h - origin.y);
            } else {
                // Keep the whole pin and its name inside the map
                minX = Math.max(minX, PIN_RADIUS - origin.x);
                maxX = Math.min(maxX, map.w - PIN_RADIUS - origin.x);
                minY = Math.max(minY, PIN_RADIUS - origin.y);
                maxY = Math.min(maxY, map.h - PIN_RADIUS - LABEL_SPACE - origin.y);
            }
        });

        dx = clamp(dx, minX, maxX);
        dy = clamp(dy, minY, maxY);

        items.forEach(function(item, index) {
            item.x = Math.round(origins[index].x + dx);
            item.y = Math.round(origins[index].y + dy);

            if (isShape(item)) {
                positionShape(map.shapes.indexOf(item));
            } else {
                positionPin(item);
            }
        });
    }

    /* Dragging */

    function pointerPosition(event) {
        const point = svg.createSVGPoint();
        point.x = event.clientX;
        point.y = event.clientY;

        return point.matrixTransform(svg.getScreenCTM().inverse());
    }

    function startMarquee(start, base) {
        drag = { kind: 'marquee', start: start, base: base, box: svgElem('rect', { class: 'location-map-marquee' }) };
        svg.appendChild(drag.box);
    }

    function updateMarquee(position) {
        const left = clamp(Math.min(drag.start.x, position.x), 0, map.w);
        const right = clamp(Math.max(drag.start.x, position.x), 0, map.w);
        const top = clamp(Math.min(drag.start.y, position.y), 0, map.h);
        const bottom = clamp(Math.max(drag.start.y, position.y), 0, map.h);

        drag.box.setAttribute('x', left);
        drag.box.setAttribute('y', top);
        drag.box.setAttribute('width', right - left);
        drag.box.setAttribute('height', bottom - top);

        // Areas have to be enclosed completely, so that selecting plants does not pick up the bed they stand in
        const hits = map.shapes.filter(function(shape) {
            return (shape.x >= left) && (shape.x + shape.w <= right) && (shape.y >= top) && (shape.y + shape.h <= bottom);
        }).concat(map.pins.filter(function(pin) {
            return (pin.x + PIN_RADIUS > left) && (pin.x - PIN_RADIUS < right) && (pin.y + PIN_RADIUS > top) && (pin.y - PIN_RADIUS < bottom);
        }));

        setSelection(drag.base.concat(hits.filter(function(item) { return drag.base.indexOf(item) === -1; })));
    }

    /**
     * Drop the running drag and put back whatever it has changed so far
     */
    function cancelDrag() {
        if (!drag) {
            return;
        }

        const cancelled = drag;
        drag = null;

        if (cancelled.kind === 'marquee') {
            cancelled.box.remove();
        } else if ((cancelled.kind === 'move') && (cancelled.moved)) {
            moveItems(cancelled.items, cancelled.origins, 0, 0);
        } else if ((cancelled.kind === 'resize') && (cancelled.moved)) {
            Object.assign(cancelled.item, cancelled.origin);
            positionShape(map.shapes.indexOf(cancelled.item));
        }
    }

    function onPointerDown(event) {
        if ((event.button !== undefined) && (event.button > 0)) {
            return;
        }

        // Further fingers belong to the two finger selection box
        if ((twoFingers) || ((event.pointerType === 'touch') && (!event.isPrimary))) {
            return;
        }

        pressing = true;
        beginDrag(event);
        pressing = false;

        flushSelectionBar();
    }

    function beginDrag(event) {
        const target = event.target.closest('[data-kind]');
        const kind = (target) ? target.getAttribute('data-kind') : null;
        const additive = event.shiftKey || event.ctrlKey || event.metaKey;
        const start = pointerPosition(event);

        if (!target) {
            if (!additive) {
                setSelection([]);
            }

            // Touch keeps dragging the ground for scrolling the map
            if (event.pointerType === 'touch') {
                return;
            }

            startMarquee(start, selection.slice());
        } else if (kind === 'handle') {
            drag = { kind: 'resize', corner: target.getAttribute('data-corner'), item: selection[0], start: start, origin: clone(selection[0]) };
        } else {
            const item = (kind === 'pin') ? pinOf(parseInt(target.getAttribute('data-plant'))) : map.shapes[parseInt(target.getAttribute('data-index'))];
            const wasSelected = isSelected(item);

            if (additive) {
                // Adds or removes the item on release. Dragging instead draws a selection box,
                // which is the only way to start one where an area covers the ground.
                drag = { kind: 'toggle', start: start, item: item };
            } else {
                if (!wasSelected) {
                    setSelection([item]);
                }

                // A plain click on one of several selected items reduces the selection to it, unless it turns into a drag
                drag = { kind: 'move', start: start, items: selection.slice(), origins: selection.map(clone), single: ((wasSelected) && (selection.length > 1)) ? item : null };
            }
        }

        svg.setPointerCapture(event.pointerId);
        event.preventDefault();
    }

    function onPointerMove(event) {
        if ((!drag) || (drag.touch)) {
            return;
        }

        const position = pointerPosition(event);
        const dx = position.x - drag.start.x;
        const dy = position.y - drag.start.y;

        if ((drag.kind === 'toggle') && (Math.hypot(dx, dy) > GRID)) {
            startMarquee(drag.start, selection.slice());
        }

        if (drag.kind === 'toggle') {
            return;
        }

        if (drag.kind === 'marquee') {
            updateMarquee(position);
        } else if (drag.kind === 'move') {
            moveItems(drag.items, drag.origins, dx, dy);

            drag.moved = true;
        } else {
            const item = drag.item;
            const origin = drag.origin;

            let left = origin.x;
            let top = origin.y;
            let right = origin.x + origin.w;
            let bottom = origin.y + origin.h;

            if (drag.corner.indexOf('w') !== -1) {
                left = clamp(snap(origin.x + dx), 0, right - MIN_SIZE);
            } else {
                right = clamp(snap(right + dx), left + MIN_SIZE, map.w);
            }

            if (drag.corner.indexOf('n') !== -1) {
                top = clamp(snap(origin.y + dy), 0, bottom - MIN_SIZE);
            } else {
                bottom = clamp(snap(bottom + dy), top + MIN_SIZE, map.h);
            }

            item.x = left;
            item.y = top;
            item.w = right - left;
            item.h = bottom - top;

            positionShape(map.shapes.indexOf(item));

            drag.moved = true;
        }
    }

    function onPointerUp(event) {
        if ((!drag) || (drag.touch)) {
            return;
        }

        const finished = drag;
        drag = null;

        if (finished.kind === 'marquee') {
            finished.box.remove();
        } else if (finished.kind === 'toggle') {
            setSelection((isSelected(finished.item)) ? selection.filter(function(other) { return other !== finished.item; }) : selection.concat([finished.item]));
        } else if (finished.moved) {
            setDirty();
        } else if (finished.single) {
            setSelection([finished.single]);
        }

        if (svg.hasPointerCapture(event.pointerId)) {
            svg.releasePointerCapture(event.pointerId);
        }

        flushSelectionBar();
    }

    /* Two finger selection box on touchscreens, where one finger on the ground scrolls the map */

    function touchPosition(event) {
        return pointerPosition({
            clientX: (event.touches[0].clientX + event.touches[1].clientX) / 2,
            clientY: (event.touches[0].clientY + event.touches[1].clientY) / 2
        });
    }

    function onTouchStart(event) {
        if (event.touches.length === 2) {
            // The first finger may already have picked up an item
            cancelDrag();

            twoFingers = true;
            startMarquee(touchPosition(event), []);
            drag.touch = true;

            setSelection([]);
        } else if (twoFingers) {
            cancelDrag();
        }

        // Keep the browser from scrolling or zooming the page while dragging
        if (((twoFingers) || (event.target.closest('[data-kind]'))) && (event.cancelable)) {
            event.preventDefault();
        }
    }

    function onTouchMove(event) {
        if (!twoFingers) {
            return;
        }

        if (event.cancelable) {
            event.preventDefault();
        }

        if ((drag) && (drag.touch) && (event.touches.length === 2)) {
            updateMarquee(touchPosition(event));
        }
    }

    function onTouchEnd(event) {
        if (!twoFingers) {
            return;
        }

        if (event.touches.length < 2) {
            cancelDrag();
            flushSelectionBar();
        }

        // The finger that is still down must not start scrolling or dragging
        if (event.touches.length === 0) {
            twoFingers = false;
        }
    }

    /* Startup */

    function init() {
        root = document.getElementById('location-map');
        if (!root) {
            return;
        }

        baseUrl = root.getAttribute('data-url');

        fetch(baseUrl, { credentials: 'same-origin' })
            .then(function(response) { return response.json(); })
            .then(function(response) {
                if (response.code !== 200) {
                    throw new Error(response.msg);
                }

                labels = response.labels;
                plants = response.plants;
                saved = response.map;
                map = clone(saved);

                const wanted = parseInt(root.getAttribute('data-highlight'));

                if (plantById(wanted)) {
                    if (pinOf(wanted)) {
                        highlight = wanted;
                        render();
                    } else {
                        editing = true;
                        placePlant(wanted);
                    }

                    root.scrollIntoView({ behavior: 'smooth', block: 'center' });
                } else {
                    render();
                }
            })
            .catch(function(error) {
                console.error(error);
            });

        window.addEventListener('beforeunload', function(event) {
            if ((editing) && (dirty)) {
                event.preventDefault();
                event.returnValue = '';
            }
        });

        document.addEventListener('keydown', function(event) {
            const typing = ['INPUT', 'TEXTAREA', 'SELECT'].indexOf(event.target.tagName) !== -1;

            const steps = { ArrowLeft: [-GRID, 0], ArrowRight: [GRID, 0], ArrowUp: [0, -GRID], ArrowDown: [0, GRID] };

            if ((!editing) || (typing) || (selection.length === 0)) {
                return;
            }

            if (event.key === 'Delete') {
                removeSelected();
            } else if (event.key === 'Escape') {
                setSelection([]);
            } else if (steps[event.key]) {
                moveItems(selection, selection.map(clone), steps[event.key][0], steps[event.key][1]);
                setDirty();
                event.preventDefault();
            }
        });
    }

    // The page content is rendered by Vue on DOMContentLoaded, so wait until after that
    window.addEventListener('load', init);
})();
