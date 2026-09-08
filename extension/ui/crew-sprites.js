export const CREW_IDS = ['research', 'planner', 'writer', 'editor', 'art', 'proof', 'layout', 'ship'];
export const crewSource = (id) => `crew/${CREW_IDS.includes(id) ? id : 'research'}-work.png`;
export function crewMarkup(id, className = '') {
  return `<span class="crew-sprite ${className}" aria-hidden="true"><img class="crew-strip" src="${crewSource(id)}" alt=""></span>`;
}
