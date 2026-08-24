const infoButton = document.querySelector('.info-button');
const infoSheet = document.querySelector('#assistant-info');
const closeButton = document.querySelector('.close-button');

infoButton?.addEventListener('click', () => {
  infoSheet?.showModal();
  infoButton.setAttribute('aria-expanded', 'true');
});

closeButton?.addEventListener('click', () => {
  infoSheet?.close();
  infoButton?.setAttribute('aria-expanded', 'false');
});

infoSheet?.addEventListener('close', () => infoButton?.setAttribute('aria-expanded', 'false'));
