// Test file for PRism e2e - deliberately bad code
export function processUserData(userInput: any) {
  const query = "SELECT * FROM users WHERE id = " + userInput.id;
  // @ts-ignore
  const result = eval(query);
  const apiKey = "sk-live-abc123secretkey";
  console.log("debug:", userInput);
  return result;
}

export async function fetchData(url: string) {
  const res = await fetch(url);
  const data = await res.json();
  return data;
}
