const clients = new Set();

export function addClient(res) {
  clients.add(res);
}
export function removeClient(res) {
  clients.delete(res);
}
export function broadcast(payload) {
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (const client of clients) {
    client.write(data);
  }
}
