export const siteConfig = {
  homeUrl: "https://www.rvsq.gouv.qc.ca/prendrerendezvous/Principale.aspx",
  rechercheUrlPart: "/prendrerendezvous/Recherche.aspx",
  selectors: {
    firstName: "[name$='AssureForm_FirstName']",
    lastName: "[name$='AssureForm_LastName']",
    nam: "[name$='AssureForm_NAM']",
    seq: "[name$='AssureForm_CardSeqNumber']",
    day: "[name$='AssureForm_Day']",
    month: "[name$='AssureForm_Month']",
    year: "[name$='AssureForm_Year']",
    genderMale: "[id*='MaleGender']",
    genderFemale: "[id*='FemaleGender']",
    csrf: "#RDVSCSRFToken",
    consultingReason: "#consultingReason",
    postalCode: "#PostalCode",
    perimeter: "#perimeterCombo",
    primaryButton: "button, input[type='submit']"
  },
  reasonMap: {
    urgent: "Consultation urgente",
    semiurgent: "Consultation semi-urgente",
    suivi: "Suivi"
  }
};
