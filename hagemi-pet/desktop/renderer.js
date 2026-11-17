(() => {
  const queue = [];
  window.__hagemiBridge?.onMessage(msg => {
    if (window.__hagemiPet) {
      window.__hagemiPet.receive(msg);
    } else {
      queue.push(msg);
    }
  });
  window.__hagemiFlushQueue = () => {
    if (!window.__hagemiPet) return;
    while (queue.length) {
      window.__hagemiPet.receive(queue.shift());
    }
  };
})();
