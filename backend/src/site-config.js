export const siteConfig = {
  baseUrl: "https://www.rvsq.gouv.qc.ca",
  homeUrl: "https://www.rvsq.gouv.qc.ca/prendrerendezvous/Principale.aspx",
  rechercheUrl: "https://www.rvsq.gouv.qc.ca/prendrerendezvous/Recherche.aspx",
  rechercheUrlPart: "/prendrerendezvous/Recherche.aspx",
  // Sélecteurs conservés pour résoudre les vrais noms de champs depuis le HTML
  selectors: {
    firstName:        "[name$='AssureForm_FirstName']",
    lastName:         "[name$='AssureForm_LastName']",
    nam:              "[name$='AssureForm_NAM']",
    seq:              "[name$='AssureForm_CardSeqNumber']",
    day:              "[name$='AssureForm_Day']",
    month:            "[name$='AssureForm_Month']",
    year:             "[name$='AssureForm_Year']",
    genderMale:       "[id*='MaleGender']",
    genderFemale:     "[id*='FemaleGender']",
    consultingReason: "#consultingReason",
    postalCode:       "#PostalCode",
    perimeter:        "#perimeterCombo",
  },
  reasonMap: {
    urgent:     "Consultation urgente",
    semiurgent: "Consultation semi-urgente",
    suivi:      "Suivi",
  },
};
