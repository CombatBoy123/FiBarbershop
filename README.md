# Fi Barbershop — kassa, arved, ladu

Salongi sisene töölaud: kiirmüük, arved, kassaraamat ja ladu. Eestikeelne,
hele ja tume teema. Andmed on Postgresis, seega igas seadmes on sama seis.

Kliendid seda ei näe — sisse pääseb ainult kontoga, mille loob omanik.

---

## Mida vaja on

- **Node.js 18+**
- **Postgres** — kas Render-i (või muu) majutatud andmebaas või lokaalselt paigaldatud

## Seadistamine

1. **Sõltuvused** (juba tehtud, aga uues masinas):

   ```
   npm install
   ```

2. **`.env`** — kopeeri `.env.example` failiks `.env` ja täida:

   | Muutuja | Mis see on |
   | --- | --- |
   | `DATABASE_URL` | Postgresi ühendusstring. Renderis: andmebaasi lehelt „External Database URL" (oma arvutist) või „Internal Database URL" (sama regiooni teenusest). |
   | `JWT_SECRET` | Pikk juhuslik string, millega allkirjastatakse sisselogimise tokenid. |
   | `PORT` | Vaikimisi 4100. Server serveerib nii API-t kui ka `public/` kausta. |
   | `ALLOWED_ORIGIN` | Jäta `*`, kui sait ja API on sama server (vaikimisi nii on). |
   | `ALLOW_PUBLIC_REGISTER` | Jäta `0`. Siis ei saa keegi end ise su raamatupidamisse registreerida. |

   `JWT_SECRET` genereerimiseks:

   ```
   node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
   ```

   `.env` on `.gitignore`-is. Ära pane seda kunagi gitti.

3. **Tabelid** tekivad ise, kui server esimest korda käivitub. Migratsioone
   käsitsi jooksutama ei pea.

## Esimene konto

Avalik registreerimine on kinni, seega esimese konto teeb see skript. **Parooli
valid sina** — anna see keskkonnamuutujaga, mitte käsurea argumendina:
argumendid jäävad shelli ajalukku ja protsessiloendisse, keskkonnamuutujad ei jää.

PowerShell:

```
$env:SEED_EMAIL="info@fibarbers.ee"; $env:SEED_PASSWORD="vali-oma-parool"; npm run seed-user
```

Parool peab olema vähemalt 8 tähemärki. Skript ei prindi seda kunagi tagasi.
Sama käsk sama e-postiga **vahetab** parooli, kui see ununeb.

Uue kontoga tuleb kaasa Fi hinnakiri (Habe + juukselõikus 45 €, Juukselõikus
35 €, Design 5 €, Afterhours DM 10 €, tervitusjook maja poolt) ja toodete
nimekiri koos osta- ja müügihindadega. Laoseis algab nullist — pane algkogused
sisse Ladu vahelehelt „Sisse (ost)" liikumistena.

## Käivitamine

```
npm start
```

Ava `http://localhost:4100`.

## Kuidas see töötab

**Kiirmüük** on peamine ekraan. Kliki teenusele või tootele, et lisada rida;
kogust ja hinda saab real muuta. Jootraha on käibemaksuvaba. Vali sularaha,
kaart või jaga — „Jaga" puhul peavad sularaha ja kaart kokku võrduma summaga,
muidu nupp ei aktiveeru.

„Lõpeta müük" teeb **ühe** serveripoolse tehinguga kolm asja:

1. koostab arve järgmise numbriga kujul `pp/kk/aa - xxx` (`30/08/26 - 001`,
   `30/08/26 - 002`, …) — loendur algab igal päeval uuesti 001-st,
2. kirjutab kassaraamatusse tulukande,
3. kannab müüdud tooted laost välja.

Kui midagi neist ebaõnnestub, ei salvestu ükski neist — raamatud ja riiul ei
saa sattuda eri seisu. Otsas olevat toodet ei saa müüa, ja laoseisu kontrollib
server tehingu sees, mitte brauser.

**Arved** — nimekiri vasakul, A4 leht kõrval. „Trüki / PDF" saadab printi
ainult lehe, ilma liideseta.

**Kassaraamat** — käsitsi kanded (üür, kaubavaru, töövahendid), jooksev jääk ja
CSV eksport. Müügist tulnud kandeid ei saa eraldi kustutada — need kuuluvad
arve juurde.

**Ladu** — jääk ja väärtus arvutatakse liikumistest, mitte ei hoita eraldi
numbrina. Väärtus on ostuhinnas. Madala jäägi piiri saab muuta Hinnakirjast.

**Hinnakiri** — teenuste hinnad, toodete osta- ja müügihinnad, käibemaksumäär,
jootraha küsimine, ning arve päise andmed (reg. nr, KMKR, IBAN). Hinna muutmine
ei muuda tagantjärele juba koostatud arveid.

## Failid

```
src/server.js          API ja staatiline serveerimine
src/db.js              Postgresi ühendus ja skeem
src/auth.js            parooliräsi, JWT, requireAuth
src/seed.js            uue konto hinnakiri ja tooted
scripts/seed-user.js   konto loomine / parooli vahetus
public/index.html      sisselogimine + rakenduse raam
public/css/app.css     kujundus (Claude Design maketist)
public/js/api.js       ainus koht, mis serveriga räägib
public/js/state.js     olek ja kõik tuletatud numbrid
public/js/views.js     kuus vaadet
public/js/main.js      käivitus, sessioon, tegevused
```

## Majutamine (Render)

1. Loo Postgres, kopeeri ühendusstring.
2. Loo Web Service samast repost: build `npm install`, start `npm start`.
3. Lisa keskkonnamuutujad: `DATABASE_URL`, `JWT_SECRET`, `ALLOWED_ORIGIN`.
   `PORT` annab Render ise.
4. Käivita seejärel `seed-user` üks kord, et konto tekiks.

## Turvalisus

- Paroolid on bcrypt-räsitud (12 ringi), ei salvestata kunagi avatekstina.
- Sisselogimine lukustub 10 minutiks pärast 8 ebaõnnestunud katset.
- Iga päring on seotud sisselogitud kasutajaga — kahe konto andmed ei segune.
- Arve summad arvutab server ridade põhjal uuesti; brauseri saadetud
  koguhinda ei usaldata.
- Toote- ja kliendinimed pannakse lehele tekstina, mitte HTML-ina.

## Mis on veel tegemata

- Kogu voog on läbi testimata **päris andmebaasiga** — seda saab teha alles
  siis, kui `DATABASE_URL` on olemas.
- Teenuse või toote **lisamine ja kustutamine** on API-s olemas
  (`POST /api/services`, `DELETE /api/products/:id`), aga Hinnakirja ekraanil
  pole selleks veel nuppu — praegu saab muuta ainult hindu.
# fi-barbershop
