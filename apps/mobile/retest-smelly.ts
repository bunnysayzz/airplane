// retest for new bot
export function bad(x: any) {
  const q = "SELECT * FROM t WHERE id=" + x.id;
  return eval(q);
}
