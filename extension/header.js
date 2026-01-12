const dragButton = document.getElementById('mkp-mapper-drag-handle');
const title = document.getElementById('mkp-mapper-title');
const closeButton = document.getElementById('mkp-mapper-close-map');
const minimizeButton = document.getElementById('mkp-mapper-minimize-map');

dragButton.addEventListener("mousedown", (e) => {
    onDrag(dragButton, e)
});

title.addEventListener("mousedown", (e) => {
    onDrag(title, e)
});

const onDrag = (el, e) => {
    e.preventDefault();

    const rect = el.getBoundingClientRect();
    const offsetX = e.clientX - rect.left; // mouse inside button
    const offsetY = e.clientY - rect.top;

    parent.postMessage({
        type: "drag-start",
        offsetX,
        offsetY,
        clientX: e.clientX,
        clientY: e.clientY
    }, "*");

    const mouseMove = (eMove) => {
        parent.postMessage({
            type: "drag-move",
            clientX: eMove.clientX,
            clientY: eMove.clientY
        }, "*");
    };

    const mouseUp = () => {
        parent.postMessage({ type: "drag-end" }, "*");
        document.removeEventListener("mousemove", mouseMove);
        document.removeEventListener("mouseup", mouseUp);
    };

    document.addEventListener("mousemove", mouseMove);
    document.addEventListener("mouseup", mouseUp);
}

closeButton.addEventListener('click', () => {
    parent.postMessage({
        type: "close-map",
    }, "*");
})

minimizeButton.addEventListener('click', () => {
    const footer = document.getElementById('mkp-mapper-footer')
    const header = document.getElementById('mkp-mapper-header');
    const map = document.getElementById('mkp-mapper-map')
    const minimized = minimizeButton.textContent === '+'
    minimizeButton.textContent = minimized ? '–' : '+'
    const headerHeight = header?.offsetHeight ? `${header?.offsetHeight}px` : null

    if (minimized) {
        // handle maximize
        if (map && footer) {
            footer.style.display = 'block'
            map.style.display = 'block'
        }
        parent.postMessage({
            type: "minimize-map",
            height: null
        }, "*");
    } else {
        // handle minimize
        if (map && footer) {
            footer.style.display = 'none'
            map.style.display = 'none'
        }
        parent.postMessage({
            type: "minimize-map",
            height: headerHeight
        }, "*");
    }

})