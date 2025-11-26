const dragButton = document.getElementById('mkp-mapper-drag-handle');

dragButton.addEventListener("mousedown", (e) => {
    e.preventDefault();

    const rect = dragButton.getBoundingClientRect();
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
});
