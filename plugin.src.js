// SPDX-License-Identifier: MIT
(() => {
    'use strict';

    if (window.LampaAnime4K) return;

    const fragments = /* ANIME4K_FRAGMENTS */ null;
    const restoreFragments = /* ANIME4K_RESTORE_FRAGMENTS */ null;
    const vertex = [
        '#version 300 es', 'out vec2 uv;',
        'void main() {',
        '    uv = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);',
        '    gl_Position = vec4(uv * 2.0 - 1.0, 0.0, 1.0);',
        '}'
    ].join('\n');
    const present = [
        '#version 300 es', 'precision highp float;',
        'in vec2 uv; out vec4 color; uniform sampler2D input0;',
        // The unflipped video upload puts the top scanline at texture y=0.
        'void main() { color = vec4(texture(input0, vec2(uv.x, 1.0 - uv.y)).rgb, 1.0); }'
    ].join('\n');

    function targetSize(width, height) {
        const scale = Math.min(2, 1920 / width, 1080 / height);
        // Upstream CNN activates only when both scale factors exceed 1.2.
        const output = [Math.round(width * scale), Math.round(height * scale)];
        return output[0] > width * 1.2 && output[1] > height * 1.2 ? output : null;
    }

    function createRenderer(canvas, width, height, output, profile) {
        canvas.width = output[0];
        canvas.height = output[1];

        const gl = canvas.getContext('webgl2', {
            alpha: false, antialias: false, depth: false, stencil: false,
            powerPreference: 'high-performance'
        });
        if (!gl) throw new Error('WebGL2 недоступен');

        const textures = [];
        const programs = [];
        let framebuffer;
        let fence;

        function dispose() {
            if (fence) gl.deleteSync(fence);
            for (const program of programs) gl.deleteProgram(program);
            for (const texture of textures) gl.deleteTexture(texture);
            gl.deleteFramebuffer(framebuffer ?? null);
            gl.getExtension('WEBGL_lose_context')?.loseContext();
        }

        function compile(type, source) {
            const shader = gl.createShader(type);
            if (!shader) throw new Error('WebGL shader allocation failed');
            gl.shaderSource(shader, source);
            gl.compileShader(shader);
            if (gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return shader;
            const message = gl.getShaderInfoLog(shader);
            gl.deleteShader(shader);
            throw new Error(message || 'WebGL shader compilation failed');
        }

        function program(fragment, units, vertexShader) {
            const pixelShader = compile(gl.FRAGMENT_SHADER, fragment);
            try {
                const result = gl.createProgram();
                if (!result) throw new Error('WebGL program allocation failed');
                programs.push(result);
                gl.attachShader(result, vertexShader);
                gl.attachShader(result, pixelShader);
                gl.linkProgram(result);
                if (!gl.getProgramParameter(result, gl.LINK_STATUS)) {
                    throw new Error(gl.getProgramInfoLog(result) || 'WebGL program link failed');
                }
                gl.useProgram(result);
                for (let unit = 0; unit < units; unit++) {
                    gl.uniform1i(gl.getUniformLocation(result, 'input' + unit), unit);
                }
                return result;
            } finally {
                gl.deleteShader(pixelShader);
            }
        }

        function texture(format, w, h, filter) {
            const result = gl.createTexture();
            if (!result) throw new Error('WebGL texture allocation failed');
            textures.push(result);
            gl.bindTexture(gl.TEXTURE_2D, result);
            gl.texStorage2D(gl.TEXTURE_2D, 1, format, w, h);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            return result;
        }

        function attach(texture) {
            gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
        }

        function checkError() {
            const error = gl.getError();
            if (error !== gl.NO_ERROR || gl.isContextLost()) {
                throw new Error('Ошибка WebGL (0x' + error.toString(16) + ')');
            }
        }

        function pass(index, inputs) {
            gl.useProgram(programs[index]);
            inputs.forEach((input, unit) => {
                gl.activeTexture(gl.TEXTURE0 + unit);
                gl.bindTexture(gl.TEXTURE_2D, input);
            });
            gl.drawArrays(gl.TRIANGLES, 0, 3);
        }

        try {
            if (!gl.getExtension('EXT_color_buffer_float')) {
                throw new Error('EXT_color_buffer_float недоступен');
            }
            const limit = gl.getParameter(gl.MAX_TEXTURE_SIZE);
            if (Math.max(width * 2, height * 2, ...output) > limit ||
                canvas.width !== gl.drawingBufferWidth || canvas.height !== gl.drawingBufferHeight) {
                throw new Error('Разрешение превышает лимит WebGL');
            }

            const useRestore = profile === 'restore';
            const upscaleOffset = useRestore ? restoreFragments.length : 0;
            const vertexShader = compile(gl.VERTEX_SHADER, vertex);
            try {
                if (useRestore) {
                    restoreFragments.forEach((fragment, index) => program(fragment, index === 7 ? 8 : 1, vertexShader));
                }
                fragments.forEach((fragment, index) => program(fragment, index === 4 ? 2 : 1, vertexShader));
                program(present, 1, vertexShader);
            } finally {
                gl.deleteShader(vertexShader);
            }

            const input = texture(gl.RGBA8, width, height, gl.LINEAR);
            const restoreFeatures = useRestore ? Array.from({ length: 7 }, () =>
                texture(gl.RGBA16F, width, height, gl.NEAREST)) : [];
            const restored = useRestore ? texture(gl.RGBA8, width, height, gl.LINEAR) : null;
            // Alternate targets for the four signed CNN feature maps.
            const features = [0, 1].map(() => texture(gl.RGBA16F, width, height, gl.NEAREST));
            const doubled = texture(gl.RGBA8, width * 2, height * 2, gl.LINEAR);
            framebuffer = gl.createFramebuffer();
            if (!framebuffer) throw new Error('WebGL framebuffer allocation failed');
            gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
            for (const target of [...restoreFeatures, ...(restored ? [restored] : []), ...features, doubled]) {
                attach(target);
                if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
                    throw new Error('WebGL framebuffer incomplete');
                }
            }
            checkError();

            return {
                dispose,
                draw(video) {
                    if (fence) {
                        const state = gl.clientWaitSync(fence, 0, 0);
                        if (state === gl.TIMEOUT_EXPIRED) return false;
                        if (state === gl.WAIT_FAILED) throw new Error('WebGL sync failed');
                        gl.deleteSync(fence);
                        fence = null;
                    }

                    gl.activeTexture(gl.TEXTURE0);
                    gl.bindTexture(gl.TEXTURE_2D, input);
                    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, video);

                    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
                    gl.viewport(0, 0, width, height);
                    if (useRestore) {
                        for (let index = 0; index < 7; index++) {
                            attach(restoreFeatures[index]);
                            pass(index, [index === 0 ? input : restoreFeatures[index - 1]]);
                        }
                        attach(restored);
                        pass(7, [input, ...restoreFeatures]);
                    }

                    for (let index = 0; index < 4; index++) {
                        attach(features[index % 2]);
                        pass(index + upscaleOffset, [index === 0 ? (restored || input) : features[(index - 1) % 2]]);
                    }

                    attach(doubled);
                    gl.viewport(0, 0, width * 2, height * 2);
                    pass(upscaleOffset + 4, [restored || input, features[1]]);

                    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
                    gl.viewport(0, 0, output[0], output[1]);
                    pass(upscaleOffset + 5, [doubled]);
                    checkError();
                    fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
                    if (!fence) throw new Error('WebGL sync allocation failed');
                    gl.flush();
                    return true;
                }
            };
        } catch (error) {
            dispose();
            throw error;
        }
    }

    const key = 'lampa_anime4k_enabled';
    const profileKey = 'lampa_anime4k_profile';
    const profiles = {
        fast: 'Быстрый',
        restore: 'Восстановление'
    };
    const selector = '.player-video__display video';
    const layoutProperties = [
        'position', 'top', 'right', 'bottom', 'left', 'width', 'height',
        'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
        'transform', 'transform-origin', 'object-fit', 'object-position',
        'z-index', 'border-radius', 'clip-path'
    ];
    let enabled = false;
    let profile = 'restore';
    let started = false;
    let settings = false;
    let session;
    let state = { mode: 'off' };

    function status() {
        return { version: '0.3.1', enabled, profile, ...state, frames: session?.frames ?? 0 };
    }
    window.LampaAnime4K = Object.freeze({ status });

    function readEnabled() {
        try {
            const value = settings
                ? window.Lampa.Storage.field(key)
                : window.localStorage.getItem(key);
            return value === true || value === 'true' || value === '1';
        } catch {
            return false;
        }
    }

    function readProfile() {
        try {
            const value = settings
                ? window.Lampa.Storage.field(profileKey)
                : window.localStorage.getItem(profileKey);
            return Object.prototype.hasOwnProperty.call(profiles, value) ? value : 'restore';
        } catch {
            return 'restore';
        }
    }

    function writeSetting(name, value) {
        if (settings) window.Lampa.Storage.set(name, value);
        else window.localStorage.setItem(name, String(value));
    }

    function findVideo() {
        const player = window.Lampa?.Player;
        const current = window.Lampa?.PlayerVideo?.video?.();
        const root = player?.render?.();
        const container = root instanceof Element ? root : root?.[0];
        if (current instanceof HTMLVideoElement && current.isConnected &&
            (container?.contains(current) || current.matches(selector))) return current;
        return (container ?? document).querySelector(selector);
    }

    function detach() {
        session?.close();
        session = null;
    }

    function sync() {
        if (!enabled) return;
        const video = findVideo();
        if (session?.video === video) {
            session.refresh();
            return;
        }
        detach();
        state = { mode: 'original', reason: 'Ожидание встроенного HTML5-видео' };
        if (video instanceof HTMLVideoElement && video.isConnected) {
            session = attach(video);
            session.refresh();
        }
    }

    function applySetting() {
        const next = readEnabled();
        const nextProfile = readProfile();
        if (next === enabled && nextProfile === profile) return;
        if (nextProfile !== profile) detach();
        enabled = next;
        profile = nextProfile;
        if (enabled) sync();
        else {
            detach();
            state = { mode: 'off' };
        }
    }

    function attach(video) {
        const events = new AbortController();
        const parent = video.parentElement;
        let canvas;
        let renderer;
        let frameRequest = null;
        let cancelRequest;
        let failed = false;
        let waiting = false;
        let closed = false;
        let sizeKey;
        let frames = 0;
        let busy = 0;
        let slow = 0;
        let samples = 0;
        let skipped = 0;
        let lastTime = -1;

        function cancelFrame() {
            if (frameRequest === null) return;
            cancelRequest(frameRequest);
            frameRequest = null;
        }

        function release() {
            cancelFrame();
            canvas?.removeEventListener('webglcontextlost', contextLost);
            canvas?.remove();
            renderer?.dispose();
            canvas = renderer = null;
            sizeKey = null;
            lastTime = -1;
            busy = slow = samples = skipped = 0;
        }

        function original(reason) {
            state = { mode: 'original', reason };
            if (canvas) canvas.style.visibility = 'hidden';
        }

        function fail(error) {
            failed = true;
            release();
            original(error.message || 'Ошибка обработки');
            console.warn('[Lampa Anime4K] Исходное изображение восстановлено.', error);
        }

        function contextLost() {
            fail(new Error('Контекст WebGL потерян'));
        }

        function layout() {
            if (!canvas) return;
            const style = getComputedStyle(video);
            for (const property of layoutProperties) {
                canvas.style.setProperty(property, style.getPropertyValue(property));
            }
            // Lampa uses a positioned video. Fill the same box on forks with a static video.
            if (style.position === 'static') {
                canvas.style.position = 'absolute';
                canvas.style.inset = '0 auto auto 0';
            }
            canvas.style.display = style.display === 'none' ? 'none' : 'block';
            canvas.style.opacity = style.opacity;
            canvas.style.visibility = state.mode === 'anime4k' ? style.visibility : 'hidden';
        }

        function bypassReason() {
            const full = document.fullscreenElement ?? document.webkitFullscreenElement;
            if (document.hidden) return 'Вкладка скрыта';
            if (document.pictureInPictureElement === video || video.webkitPresentationMode === 'picture-in-picture') {
                return 'Картинка в картинке';
            }
            if (video.webkitDisplayingFullscreen || (full && !full.contains(parent))) {
                return 'Нативный полноэкранный режим';
            }
            if (video.controls || Array.from(video.textTracks ?? []).some(track => track.mode === 'showing')) {
                return 'Нативные субтитры или управление';
            }
            if (video.mediaKeys) return 'Защищённое видео';
            return null;
        }

        function schedule() {
            if (frameRequest !== null || (video.paused && state.mode === 'anime4k') || video.ended) return;
            const useVideoCallback = !video.paused && video.requestVideoFrameCallback &&
                video.cancelVideoFrameCallback;
            frameRequest = useVideoCallback
                ? video.requestVideoFrameCallback(onFrame)
                : requestAnimationFrame(onFrame);
            cancelRequest = useVideoCallback
                ? id => video.cancelVideoFrameCallback(id)
                : cancelAnimationFrame;
        }

        function onFrame() {
            frameRequest = null;
            refresh(true);
        }

        function refresh(fromFrame = false) {
            if (closed) return;
            if (!video.isConnected || video.parentElement !== parent) {
                close();
                original('Плеер закрыт');
                if (session?.video === video) session = null;
                return;
            }
            if (failed) return;

            const reason = bypassReason();
            if (reason) {
                cancelFrame();
                original(reason);
                return;
            }
            if (waiting || video.seeking || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
                cancelFrame();
                original('Ожидание кадра');
                return;
            }

            const { videoWidth: width, videoHeight: height } = video;
            const output = width && height ? targetSize(width, height) : null;
            if (!output) {
                release();
                original('Разрешение источника вне диапазона апскейла');
                return;
            }

            try {
                const dimensions = width + '×' + height;
                if (sizeKey !== dimensions) {
                    release();
                    canvas = document.createElement('canvas');
                    canvas.className = 'lampa-anime4k-surface';
                    canvas.setAttribute('aria-hidden', 'true');
                    canvas.style.pointerEvents = 'none';
                    canvas.style.visibility = 'hidden';
                    video.after(canvas);
                    canvas.addEventListener('webglcontextlost', contextLost);
                    renderer = createRenderer(canvas, width, height, output, profile);
                    sizeKey = dimensions;
                    layout();
                }

                if (state.mode !== 'anime4k' || (fromFrame &&
                    (video.requestVideoFrameCallback || video.currentTime !== lastTime))) {
                    const start = performance.now();
                    if (renderer.draw(video)) {
                        busy = 0;
                        slow = performance.now() - start > 45 ? slow + 1 : 0;
                        lastTime = video.currentTime;
                        frames++;
                        state = { mode: 'anime4k', source: dimensions, output: output.join('×') };
                        if (canvas.style.visibility === 'hidden') layout();
                    } else if (fromFrame) {
                        busy++;
                        skipped++;
                    }
                    if (fromFrame) samples++;
                    if (busy >= 8 || slow >= 8 || (samples >= 48 && skipped >= 16)) {
                        fail(new Error('GPU не успевает обрабатывать кадры'));
                        return;
                    }
                    if (samples >= 48) samples = skipped = 0;
                }
                schedule();
            } catch (error) {
                fail(error);
            }
        }

        function resume() {
            waiting = false;
            refresh();
        }

        function wait() {
            waiting = true;
            cancelFrame();
            original('Ожидание кадра');
        }

        function reset() {
            release();
            failed = waiting = false;
            frames = 0;
            original('Ожидание нового источника');
        }

        function close() {
            closed = true;
            events.abort();
            observer.disconnect();
            resizeObserver.disconnect();
            release();
        }

        const options = { signal: events.signal };
        for (const name of ['loadeddata', 'canplay', 'playing', 'seeked', 'resize']) {
            video.addEventListener(name, resume, options);
        }
        for (const name of ['waiting', 'seeking', 'error']) video.addEventListener(name, wait, options);
        for (const name of ['emptied', 'loadstart']) video.addEventListener(name, reset, options);
        for (const name of ['enterpictureinpicture', 'leavepictureinpicture', 'webkitbeginfullscreen',
            'webkitendfullscreen', 'webkitpresentationmodechanged']) {
            video.addEventListener(name, () => refresh(), options);
        }
        for (const name of ['fullscreenchange', 'webkitfullscreenchange', 'visibilitychange']) {
            document.addEventListener(name, () => { layout(); refresh(); }, options);
        }
        video.textTracks?.addEventListener('change', () => refresh(), options);
        window.addEventListener('resize', layout, options);

        const observer = new MutationObserver(() => { layout(); refresh(); });
        observer.observe(video, { attributes: true, attributeFilter: ['style', 'class', 'controls'] });
        observer.observe(parent, { childList: true });
        const resizeObserver = new ResizeObserver(layout);
        resizeObserver.observe(video);
        return { video, close, refresh, get frames() { return frames; } };
    }

    function addPlayerMenu(lampa) {
        if (!lampa.Select?.listener?.follow || !lampa.Select.show) return;

        lampa.Select.listener.follow('preshow', event => {
            const parent = event?.active;
            const items = parent?.items;
            if (!Array.isArray(items) ||
                !items.some(item => item?.method === 'size') ||
                !items.some(item => item?.method === 'speed')) return;

            const previous = items.find(item => item?.anime4kMenu);
            if (previous) {
                previous.subtitle = enabled ? profiles[profile] : 'Выключено';
                return;
            }

            items.push({
                title: 'Anime4K',
                subtitle: enabled ? profiles[profile] : 'Выключено',
                anime4kMenu: true,
                onSelect() {
                    lampa.Select.show({
                        title: 'Anime4K',
                        items: [
                            { title: 'Выключено', value: 'off', selected: !enabled },
                            {
                                title: profiles.fast,
                                subtitle: 'Масштабирование с меньшей нагрузкой',
                                value: 'fast',
                                selected: enabled && profile === 'fast'
                            },
                            {
                                title: profiles.restore,
                                subtitle: 'Восстановление изображения и масштабирование',
                                value: 'restore',
                                selected: enabled && profile === 'restore'
                            }
                        ],
                        onSelect(item) {
                            if (item.value === 'off') writeSetting(key, false);
                            else {
                                writeSetting(profileKey, item.value);
                                writeSetting(key, true);
                            }
                            applySetting();
                            lampa.Select.show(parent);
                        },
                        onBack() {
                            lampa.Select.show(parent);
                        }
                    });
                }
            });
        });
    }

    function init() {
        if (started) return;
        started = true;
        const lampa = window.Lampa;
        if (lampa?.SettingsApi?.addComponent && lampa.SettingsApi.addParam &&
            lampa.Storage?.field && lampa.Storage.set) {
            lampa.SettingsApi.addComponent({
                component: 'lampa_anime4k',
                name: 'Anime4K',
                icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" fill="none" aria-hidden="true">' +
                    '<rect x="3.5" y="6" width="33" height="28" rx="4" stroke="white" stroke-width="2.5"/>' +
                    '<path d="M11 27l6-8 4 5 3-4 5 7H11z" stroke="white" stroke-width="2.3" stroke-linejoin="round"/>' +
                    '<path d="M27.5 10.5l.9 2.6 2.6.9-2.6.9-.9 2.6-.9-2.6-2.6-.9 2.6-.9.9-2.6z" fill="white"/>' +
                    '</svg>'
            });
            lampa.SettingsApi.addParam({
                component: 'lampa_anime4k',
                param: { name: key, type: 'trigger', default: false },
                field: {
                    name: 'Улучшение аниме',
                    description: 'До 1080p во встроенном плеере. Alt+Shift+A переключает режим при просмотре.'
                },
                onChange: () => queueMicrotask(applySetting)
            });
            lampa.SettingsApi.addParam({
                component: 'lampa_anime4k',
                param: { name: profileKey, type: 'select', values: profiles, default: 'restore' },
                field: { name: 'Режим Anime4K' },
                onChange: () => queueMicrotask(applySetting)
            });
            settings = true;
            lampa.Storage.listener?.follow?.('change', event => {
                if (event.name === key || event.name === profileKey) applySetting();
            });
        }

        addPlayerMenu(lampa);
        const listener = lampa?.Player?.listener;
        listener?.follow?.('start', () => {
            detach();
            if (enabled) state = { mode: 'original', reason: 'Ожидание новой серии' };
        });
        listener?.follow?.('ready', sync);
        listener?.follow?.('destroy', () => {
            detach();
            if (enabled) state = { mode: 'original', reason: 'Плеер закрыт' };
        });

        // Some forks replace the video element without emitting Player.ready.
        for (const name of ['loadeddata', 'playing']) {
            document.addEventListener(name, event => {
                if (enabled && event.target !== session?.video && event.target === findVideo()) sync();
            }, true);
        }

        document.addEventListener('keydown', event => {
            if (event.code !== 'KeyA' || !event.altKey || !event.shiftKey ||
                event.ctrlKey || event.metaKey || event.repeat || event.isComposing ||
                event.target?.closest?.('input, textarea, select, [contenteditable]') ||
                !findVideo()?.getClientRects().length) return;
            event.preventDefault();
            event.stopPropagation();
            writeSetting(key, !enabled);
            applySetting();
            lampa?.Noty?.show?.('Anime4K ' + (enabled ? 'включён' : 'выключен'));
        }, true);

        applySetting();
    }

    if (window.appready || !window.Lampa?.Listener?.follow) init();
    else window.Lampa.Listener.follow('app', event => {
        if (event.type === 'ready') init();
    });
})();
