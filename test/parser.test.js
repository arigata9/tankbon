import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseReceipt } from '../src/parser.js';

const now = new Date('2026-11-13T12:00:00Z');

test('Aral-Bon mit Liter x Preis/Liter in einer Zeile', () => {
  const text = `ARAL Tankstelle
Hauptstraße 12
80331 München
Tel. 089 123456

Säule 4   Super E10
42,57 l x 1,779 EUR/l
                    75,73 EUR

Summe EUR           75,73
girocard            75,73
Netto               63,64
MwSt 19%            12,09

12.11.2026  17:42  Bon-Nr. 4711
Vielen Dank für Ihren Besuch`;
  const r = parseReceipt(text, { now });
  assert.equal(r.station, 'Aral München');
  assert.equal(r.receipt_date, '2026-11-12');
  assert.equal(r.liters, 42.57);
  assert.equal(r.price_per_liter, 1.779);
  assert.equal(r.total, 75.73);
  assert.equal(r.fuel_type, 'Super E10');
  assert.equal(r.consistent, true);
});

test('Shell-Bon mit getrennten Zeilen und Bargeld', () => {
  const text = `Shell Station
Industriestr. 5
70565 Stuttgart
Diesel
Menge: 55,02 L
Preis/L: 1,659 €
Betrag: 91,28 €
BAR gegeben 100,00
Rückgeld 8,72
Datum: 03.10.26 Uhrzeit: 08:15`;
  const r = parseReceipt(text, { now });
  assert.equal(r.station, 'Shell Stuttgart');
  assert.equal(r.receipt_date, '2026-10-03');
  assert.equal(r.liters, 55.02);
  assert.equal(r.price_per_liter, 1.659);
  assert.equal(r.total, 91.28);
  assert.equal(r.fuel_type, 'Diesel');
});

test('Hochgestellte 9 beim Literpreis, von OCR abgetrennt', () => {
  const text = `JET
01067 Dresden
Super E5
30,00 l   1,85 9 EUR/l
Gesamt EUR 55,77
EC-Karte 55,77
01.09.2026 12:01`;
  const r = parseReceipt(text, { now });
  assert.equal(r.station, 'JET Dresden');
  assert.equal(r.price_per_liter, 1.859);
  assert.equal(r.liters, 30);
  assert.equal(r.total, 55.77);
  assert.equal(r.fuel_type, 'Super E5');
});

test('Liter fehlen – werden aus Summe und Literpreis berechnet', () => {
  const text = `Esso Station
Super Plus
Preis/L 1,899
Summe 47,48 EUR
15.08.2026`;
  const r = parseReceipt(text, { now });
  assert.equal(r.station, 'Esso');
  assert.equal(r.price_per_liter, 1.899);
  assert.equal(r.total, 47.48);
  assert.equal(r.liters, 25);
  assert.equal(r.fuel_type, 'Super Plus');
});

test('Shop-Artikel und MwSt stören die Erkennung nicht', () => {
  const text = `TotalEnergies Tankstelle
10115 Berlin
Kaffee groß           3,49
Diesel  S.2
38,11 l * 1,699       64,75
Summe                 68,24
Visa                  68,24
MwSt A 19,0% 10,90  Netto 57,34
TSE Start 2026-11-01T10:11:12`;
  const r = parseReceipt(text, { now });
  assert.equal(r.station, 'TotalEnergies Berlin');
  assert.equal(r.liters, 38.11);
  assert.equal(r.price_per_liter, 1.699);
  assert.equal(r.total, 64.75);
  assert.equal(r.receipt_date, '2026-11-01');
});

test('Leerer Text liefert leere Felder statt Fehler', () => {
  const r = parseReceipt('', { now });
  assert.equal(r.liters, null);
  assert.equal(r.total, null);
  assert.equal(r.receipt_date, null);
});

test('iPad-Texterkennung: Bezeichnungen und Werte auf getrennten Zeilen', () => {
  const text = 'Shell Station\n70565 Stuttgart\nDiesel\nMenge:\n55,02 L\nPreis/L:\n1,659 €\nBetrag:\n91,28 €\n03.10.2026';
  const r = parseReceipt(text, { now });
  assert.equal(r.liters, 55.02);
  assert.equal(r.price_per_liter, 1.659);
  assert.equal(r.total, 91.28);
  assert.equal(r.receipt_date, '2026-10-03');
});

test('Produktname vom Bon statt Kategorie (TotalEnergies, Excellium)', () => {
  const text = `TotalEnergies Tankstelle
Bahnstr. 174
41069 Mönchengladbach
* 35,20 Liter # 02 *
Excellium Super Plus * €    86,20*A
2,449 € / Liter
Summe € 86,20
Mastercard € 86,20
19,00 % MWST. A € 13,76
Summe Netto € 72,44
Datum/Uhrzeit 18.09.2026 19:24:25`;
  const r = parseReceipt(text, { now });
  assert.equal(r.fuel_type, 'Excellium Super Plus');
  assert.equal(r.station, 'TotalEnergies Mönchengladbach');
  assert.equal(r.liters, 35.2);
  assert.equal(r.price_per_liter, 2.449);
  assert.equal(r.total, 86.2);
  assert.equal(r.receipt_date, '2026-09-18');
});

test('Produktname in Großbuchstaben wird lesbar geschrieben', () => {
  const r = parseReceipt('Shell\nV-POWER DIESEL\n40,00 l x 1,899 EUR/l\nSumme 75,96', { now });
  assert.equal(r.fuel_type, 'V-Power Diesel');
});
