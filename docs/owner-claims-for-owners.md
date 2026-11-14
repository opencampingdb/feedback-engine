# Claiming your place: steps for owners

The steps an owner follows, in plain words. The section "Text for an email" can be sent to an owner as it is, with the place's link filled in. [owners.md](owners.md) has the rules behind each step.

## Before you start

You need a page on the internet that you control and that belongs to your place: a page of your own website, or your public social page. It must start with `https://` and open without logging in.

## Steps

1. **Open the claim page**: https://opencampingdb.github.io/owners/claim.html. Find your place by typing its name.
2. **Give the address of your page**, your name and your email, and tick the owner terms. Your name and email are kept private and are never published.
3. **Send the claim.** You get three things. Keep the page open until you have saved them:
   - a **code**, such as `OCDB-7KQ2-M4XP`
   - a **token**, 43 characters long. Save it somewhere safe, such as a password manager. It is shown once and cannot be shown again
   - a reference that starts with `fb_`
4. **Put the code on the page whose address you gave.** Either:
   - add this line to the head of the page, with your own code. This is the best proof, and your web developer or site builder can do it in a minute:

     ```html
     <meta name="opencampingdb-claim" content="OCDB-7KQ2-M4XP">
     ```

   - or type the code anywhere in the page's text, such as at the bottom of your About page
5. **Wait.** The page is checked several times a day for 7 days. Once the code is found, a person looks at your claim, usually within a few days.
6. **Update your place.** Once your claim is approved, open https://opencampingdb.github.io/owners/update.html, find your place, paste your token and send your changes. Most appear within a day.

You can take the code off your page once your claim is approved.

## If something goes wrong

- **The code is not found.** The page must show the code to a visitor who is not logged in, as part of the page itself. Most Facebook pages ask visitors to log in, so use your website when you have one. If your site shows a "checking your browser" page to automated visitors, ask your web host to let through the visitor that names itself `OpenCampingDB/1.0`.
- **You gave the wrong page.** Send a new claim with the right address.
- **You lost your token.** Claim again. When the new claim is approved it replaces the old token.
- **Your claim was refused.** Claim again with a page that is clearly your place's own, such as your website's home page.
- **You no longer run the place.** Tell us through the contact links at the foot of the claim page, so the claim can be ended.

## Text for an email

Replace the link in step 1 with the place's own link, `https://opencampingdb.github.io/owners/claim.html?place=<place id>`, so the place is chosen for the owner.

```
Subject: Claim your place on Open Camping DB

Hello,

Open Camping DB is a free, open list of places to camp and stop in Australia. Your place is on it. If you claim it, you can keep its details, description, booking link and opening dates up to date yourself, and apps that use the list can show it as owner verified. It costs nothing and there is no account to create.

It takes about five minutes:

1. Open this page: https://opencampingdb.github.io/owners/claim.html
2. Find your place, then give the address of a page on your own website (it must start with https://), your name and your email. Your name and email stay private.
3. Send the claim. You are shown a code and a token. Save the token somewhere safe: it is shown only once, and you need it to update your place later.
4. Put the code on the page whose address you gave. Anywhere on the page works. If someone looks after your website, ask them to add it as a meta tag named "opencampingdb-claim" in the head of the page, which is the best proof.
5. We check your page several times a day for 7 days. Once we see the code, a person reviews your claim, usually within a few days.
6. After that, update your place any time at https://opencampingdb.github.io/owners/update.html with your token.

If you lose the token, claim again and the new one replaces it. You can remove the code from your page once your claim is approved.

What you send about your place is published under the Open Database Licence, so anyone may use and share it. The owner terms are at https://opencampingdb.github.io/owners/terms.html
```
