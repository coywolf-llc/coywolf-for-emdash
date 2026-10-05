/**
 * Schema.org catalogs for the Schema & Social module, matching Coywolf SEO
 * on WordPress: WebPage and Article subtypes, and the Organization and
 * Person properties offered in the property pickers. Shared by the routes
 * (validation) and the admin page (choices).
 */

export const PAGE_TYPES: Array<[string, string]> = [
	["WebPage", "Web Page"],
	["AboutPage", "About Page"],
	["CheckoutPage", "Checkout Page"],
	["CollectionPage", "Collection Page"],
	["ContactPage", "Contact Page"],
	["FAQPage", "FAQ Page"],
	["ItemPage", "Item Page"],
	["MedicalWebPage", "Medical Web Page"],
	["ProfilePage", "Profile Page"],
	["QAPage", "Q&A Page"],
	["RealEstateListing", "Real Estate Listing"],
	["SearchResultsPage", "Search Results Page"],
];

export const ARTICLE_TYPES: Array<[string, string]> = [
	["none", "None (no Article)"],
	["Article", "Article"],
	["AdvertiserContentArticle", "Advertiser Content Article"],
	["AnalysisNewsArticle", "Analysis News Article"],
	["APIReference", "API Reference"],
	["AskPublicNewsArticle", "Ask Public News Article"],
	["BackgroundNewsArticle", "Background News Article"],
	["BlogPosting", "Blog Posting"],
	["DiscussionForumPosting", "Discussion Forum Posting"],
	["LiveBlogPosting", "Live Blog Posting"],
	["MedicalScholarlyArticle", "Medical Scholarly Article"],
	["NewsArticle", "News Article"],
	["OpinionNewsArticle", "Opinion News Article"],
	["Report", "Report"],
	["ReportageNewsArticle", "Reportage News Article"],
	["ReviewNewsArticle", "Review News Article"],
	["SatiricalArticle", "Satirical Article"],
	["ScholarlyArticle", "Scholarly Article"],
	["SocialMediaPosting", "Social Media Posting"],
	["TechArticle", "Tech Article"],
];

export const ORGANIZATION_PROPERTIES = [
	"@id", "name", "alternateName", "legalName", "description", "url", "logo", "image", "email", "telephone",
	"faxNumber", "address", "location", "areaServed", "foundingDate", "foundingLocation", "founder",
	"numberOfEmployees", "duns", "taxID", "vatID", "leiCode", "naics", "isicV4", "iso6523Code", "tickerSymbol",
	"sameAs", "slogan", "keywords", "knowsAbout", "knowsLanguage", "award", "brand", "parentOrganization",
	"subOrganization", "memberOf", "member", "sponsor", "funder", "contactPoint", "identifier", "ethicsPolicy",
	// Publishing policies (news publishers; Google and the Trust Project read these).
	"publishingPrinciples", "masthead", "missionCoveragePrioritiesPolicy", "diversityPolicy", "diversityStaffingReport", "correctionsPolicy", "verificationFactCheckingPolicy", "unnamedSourcesPolicy", "actionableFeedbackPolicy", "ownershipFundingInfo", "noBylinesPolicy",
];

/** Organization types for the publisher (Organization and common subtypes). */
export const ORGANIZATION_TYPES: Array<[string, string]> = [
	["Organization", "Organization"],
	["NewsMediaOrganization", "News media organization"],
	["Corporation", "Corporation"],
	["OnlineBusiness", "Online business"],
	["LocalBusiness", "Local business"],
	["EducationalOrganization", "Educational organization"],
	["NGO", "Nonprofit (NGO)"],
	["GovernmentOrganization", "Government organization"],
	["MedicalOrganization", "Medical organization"],
	["SportsOrganization", "Sports organization"],
	["PerformingGroup", "Performing group"],
];

export const PERSON_PROPERTIES = [
	"@id", "name", "additionalName", "alternateName", "givenName", "familyName", "honorificPrefix",
	"honorificSuffix", "description", "disambiguatingDescription", "url", "image", "email", "telephone",
	"jobTitle", "worksFor", "affiliation", "alumniOf", "memberOf", "hasOccupation", "knowsAbout", "knowsLanguage",
	"nationality", "homeLocation", "workLocation", "address", "birthDate", "birthPlace", "award", "brand",
	"callSign", "colleague", "gender", "sameAs",
];

export type InputKind = "text" | "url" | "image" | "email" | "tel" | "date" | "number";

export interface PropertyInput {
	input?: InputKind;
	fields?: Record<string, { label: string; input: InputKind }>;
}

const ENTITY_REF: PropertyInput = {
	fields: {
		name: { label: "Name", input: "text" },
		url: { label: "URL", input: "url" },
		"@id": { label: "@id (entity reference)", input: "url" },
	},
};

/** Input type per property; structured properties list their sub-fields. Unlisted properties are plain text. */
export const PROPERTY_INPUTS: Record<string, PropertyInput> = {
	"@id": { input: "url" },
	url: { input: "url" },
	sameAs: { input: "url" },
	logo: { input: "image" },
	image: { input: "image" },
	email: { input: "email" },
	telephone: { input: "tel" },
	faxNumber: { input: "tel" },
	foundingDate: { input: "date" },
	birthDate: { input: "date" },
	numberOfEmployees: { input: "number" },
	ethicsPolicy: { input: "url" },
	publishingPrinciples: { input: "url" },
	masthead: { input: "url" },
	missionCoveragePrioritiesPolicy: { input: "url" },
	diversityPolicy: { input: "url" },
	diversityStaffingReport: { input: "url" },
	correctionsPolicy: { input: "url" },
	verificationFactCheckingPolicy: { input: "url" },
	unnamedSourcesPolicy: { input: "url" },
	actionableFeedbackPolicy: { input: "url" },
	ownershipFundingInfo: { input: "url" },
	noBylinesPolicy: { input: "url" },
	address: {
		fields: {
			streetAddress: { label: "Street address", input: "text" },
			addressLocality: { label: "City", input: "text" },
			addressRegion: { label: "Region / State", input: "text" },
			postalCode: { label: "Postal code", input: "text" },
			addressCountry: { label: "Country (two-letter code, like US)", input: "text" },
		},
	},
	contactPoint: {
		fields: {
			telephone: { label: "Telephone", input: "tel" },
			email: { label: "Email", input: "email" },
			contactType: { label: "Contact type (customer support, sales, …)", input: "text" },
		},
	},
	worksFor: ENTITY_REF,
	affiliation: ENTITY_REF,
	alumniOf: ENTITY_REF,
	memberOf: ENTITY_REF,
	founder: ENTITY_REF,
	parentOrganization: ENTITY_REF,
	subOrganization: ENTITY_REF,
	brand: ENTITY_REF,
};

/** Rows prefilled for a new author, like the WordPress Authors page. */
export const DEFAULT_AUTHOR_PROPS = ["name", "url", "description", "image", "jobTitle", "sameAs"];
