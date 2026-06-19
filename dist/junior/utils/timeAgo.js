export function timeAgo(timestamp) {
    const seconds = Math.floor((Date.now() - timestamp) / 1000);
    if (seconds < 60)
        return `${seconds}sn önce`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60)
        return `${minutes}dk önce`;
    return `${Math.floor(minutes / 60)}sa önce`;
}
//# sourceMappingURL=timeAgo.js.map